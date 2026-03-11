/**
 * Split Detector "Airbag" — detects mixed events and splits them.
 *
 * Uses cheap K=2 k-means clustering on existing embeddings to detect
 * when an event contains articles about two distinct stories.
 *
 * Triggered after auto-link when event has enough articles.
 */

import { ulid } from 'ulid';
import { EventBus, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { cosineSimilarity, computeCentroid } from './similarity.js';
import {
  SPLIT_DETECTOR_ENABLED,
  SPLIT_MIN_ARTICLES,
  SPLIT_CHECK_COOLDOWN_MIN,
  SPLIT_K,
  SPLIT_MIN_SEPARATION,
  SPLIT_MAX_WITHIN_COHESION,
} from './config.js';

// In-memory cooldown tracker (eventId → last check timestamp)
const splitCooldowns = new Map<string, number>();

export interface SplitResult {
  didSplit: boolean;
  newEventId?: string;
  movedArticleCount?: number;
  separation?: number;
  withinCohesion?: number;
}

/**
 * K=2 k-means clustering using cosine distance.
 *
 * 1. Initialize with farthest pair
 * 2. Run 3 iterations of assignment + centroid recompute
 * 3. Return two clusters
 */
export function kMeans2(
  vectors: number[][],
  maxIter: number = 3,
): { clusters: [number[], number[]]; centroids: [number[], number[]] } {
  if (vectors.length < 2) {
    return { clusters: [vectors.map((_, i) => i), []], centroids: [vectors[0] ?? [], []] };
  }

  // Find farthest pair for initialization
  let maxDist = -1;
  let seedA = 0;
  let seedB = 1;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      const dist = 1 - cosineSimilarity(vectors[i], vectors[j]);
      if (dist > maxDist) {
        maxDist = dist;
        seedA = i;
        seedB = j;
      }
    }
  }

  let centroidA = [...vectors[seedA]];
  let centroidB = [...vectors[seedB]];

  let clusterA: number[] = [];
  let clusterB: number[] = [];

  for (let iter = 0; iter < maxIter; iter++) {
    clusterA = [];
    clusterB = [];

    // Assign each vector to nearest centroid
    for (let i = 0; i < vectors.length; i++) {
      const simA = cosineSimilarity(vectors[i], centroidA);
      const simB = cosineSimilarity(vectors[i], centroidB);
      if (simA >= simB) {
        clusterA.push(i);
      } else {
        clusterB.push(i);
      }
    }

    // Recompute centroids
    if (clusterA.length > 0) {
      centroidA = computeCentroid(clusterA.map((i) => vectors[i]));
    }
    if (clusterB.length > 0) {
      centroidB = computeCentroid(clusterB.map((i) => vectors[i]));
    }
  }

  return { clusters: [clusterA, clusterB], centroids: [centroidA, centroidB] };
}

/**
 * Calculate within-cluster cohesion (avg cosine distance to centroid).
 */
export function withinCohesion(vectors: number[][], centroid: number[]): number {
  if (vectors.length === 0) return 0;
  let totalDist = 0;
  for (const v of vectors) {
    totalDist += 1 - cosineSimilarity(v, centroid);
  }
  return totalDist / vectors.length;
}

export class SplitDetector {
  constructor(
    private eventRepo: EventRepository,
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
  ) {}

  /**
   * Check if an event should be split after a new article is linked.
   * Called from the event linker after auto-link or from lifecycle events.
   */
  async checkAndSplit(eventId: string, traceId: string): Promise<SplitResult> {
    if (!SPLIT_DETECTOR_ENABLED) {
      return { didSplit: false };
    }

    // Cooldown check
    const lastCheck = splitCooldowns.get(eventId);
    const now = Date.now();
    if (lastCheck && (now - lastCheck) < SPLIT_CHECK_COOLDOWN_MIN * 60 * 1000) {
      logger.debug({ event_id: eventId, cooldown_remaining_ms: (lastCheck + SPLIT_CHECK_COOLDOWN_MIN * 60 * 1000) - now }, 'split_detector_cooldown');
      return { didSplit: false };
    }

    // Get articles for the event
    const articles = await this.eventRepo.findArticlesForEvent(eventId);

    if (articles.length < SPLIT_MIN_ARTICLES) {
      return { didSplit: false };
    }

    // Extract embeddings
    const articlesWithVecs = articles.filter((a: any) => a.embeddingVec);
    if (articlesWithVecs.length < SPLIT_MIN_ARTICLES) {
      return { didSplit: false };
    }

    const vectors = articlesWithVecs.map((a: any) => a.embeddingVec as number[]);
    const articleIds = articlesWithVecs.map((a: any) => a.id as string);

    // Run K=2 clustering
    const { clusters, centroids } = kMeans2(vectors, 3);
    const [clusterA, clusterB] = clusters;
    const [centroidA, centroidB] = centroids;

    // Need at least 1 article in each cluster
    if (clusterA.length === 0 || clusterB.length === 0) {
      splitCooldowns.set(eventId, now);
      return { didSplit: false };
    }

    // Calculate metrics
    const separation = 1 - cosineSimilarity(centroidA, centroidB);
    // within_cohesion: avg distance of ALL points to the overall event centroid
    // High value → event is NOT cohesive (mixed), suggesting a split is warranted
    const overallCentroid = computeCentroid(vectors);
    const avgCohesion = withinCohesion(vectors, overallCentroid);

    logger.info({
      event_id: eventId,
      article_count: articlesWithVecs.length,
      cluster_sizes: [clusterA.length, clusterB.length],
      separation: +separation.toFixed(4),
      within_cohesion: +avgCohesion.toFixed(4),
      thresholds: { min_separation: SPLIT_MIN_SEPARATION, max_cohesion: SPLIT_MAX_WITHIN_COHESION },
    }, 'split_detector_analysis');

    splitCooldowns.set(eventId, now);

    // Check split condition
    if (separation >= SPLIT_MIN_SEPARATION && avgCohesion >= SPLIT_MAX_WITHIN_COHESION) {
      return this.executeSplit(eventId, articleIds, clusterA, clusterB, separation, avgCohesion, traceId);
    }

    return { didSplit: false, separation, withinCohesion: avgCohesion };
  }

  private async executeSplit(
    eventId: string,
    articleIds: string[],
    clusterA: number[],
    clusterB: number[],
    separation: number,
    withinCohesion: number,
    traceId: string,
  ): Promise<SplitResult> {
    // Minority cluster gets moved to new event
    const [keepCluster, moveCluster] = clusterA.length >= clusterB.length
      ? [clusterA, clusterB]
      : [clusterB, clusterA];

    const movedIds = moveCluster.map((i) => articleIds[i]);

    // Create new event
    const now = new Date();
    const newEvent = await this.eventRepo.create({
      state: 'DETECTED',
      t0: now,
      tLast: now,
    });

    // Move articles to new event: link to new, unlink from old
    for (const artId of movedIds) {
      await this.eventRepo.linkArticle(newEvent.id, artId);
    }
    // Unlink moved articles from old event
    for (const artId of movedIds) {
      await this.unlinkArticle(eventId, artId);
    }

    logger.info({
      old_event_id: eventId,
      new_event_id: newEvent.id,
      moved_article_count: movedIds.length,
      kept_article_count: keepCluster.length,
      separation: +separation.toFixed(4),
      within_cohesion: +withinCohesion.toFixed(4),
    }, 'split_detector_executed');

    metrics.incCounter('linking.split_executed_total');

    // Audit
    await this.auditWriter.write({
      entity_type: 'EVENT',
      entity_id: eventId,
      action: 'EVENT_SPLIT',
      trace_id: traceId,
      data: {
        old_event_id: eventId,
        new_event_id: newEvent.id,
        moved_article_ids_count: movedIds.length,
        reason: 'EMBED_CLUSTER_K2',
        separation,
        within_cohesion: withinCohesion,
      },
    });

    // Publish EventSplit event for downstream (re-enrich both events)
    await this.eventBus.publish({
      event_name: 'EventSplitCreated',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'split_detector' },
      payload: {
        old_event_id: eventId,
        new_event_id: newEvent.id,
        moved_article_ids: movedIds,
      },
    });

    return {
      didSplit: true,
      newEventId: newEvent.id,
      movedArticleCount: movedIds.length,
      separation,
      withinCohesion,
    };
  }

  private async unlinkArticle(eventId: string, articleId: string): Promise<void> {
    await this.eventRepo.unlinkArticle(eventId, articleId);
  }

  /** Exposed for testing: clear cooldown cache */
  static clearCooldowns(): void {
    splitCooldowns.clear();
  }
}
