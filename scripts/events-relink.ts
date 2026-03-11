/**
 * events-relink — Re-link articles from problematic events using current hard-negative gates.
 *
 * Usage:
 *   npm run debug:events:relink -- --sinceHours=24 --limit=200          # dry-run (default)
 *   npm run debug:events:relink -- --sinceHours=24 --limit=200 --apply  # execute
 *
 * Pipeline:
 *   1) Query events within sinceHours with quality issues (split_proxy, coherence_fail, etc.)
 *   2) For each event, extract articles with embeddings
 *   3) Re-run pair scoring + hard-negative gates between each article pair
 *   4) Group articles into new clusters
 *   5) --apply: Create new events, re-link articles, mark originals as CLOSED + canonicalEventId
 *   6) Report: merges_attempted, merges_blocked (by reason), merges_applied
 *
 * Idempotent: events with canonicalEventId set are skipped (already superseded).
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { detectIntraSplitProxy } from '../src/modules/quality/detectors/intra-split-proxy.js';
import { classifyTopic } from '../src/modules/topics/service/topic-heuristic.js';
import {
  extractDesk,
  desksCompatible,
  extractTitleKeywords,
  extractTitleEntities,
  jaccardSets,
} from '../src/modules/event_linker/service/hard-negative-gates.js';
import { cosineSimilarity } from '../src/modules/event_linker/service/similarity.js';
import { THETA_AUTO_LINK } from '../src/modules/event_linker/service/pair-scorer.js';

// ── CLI arg parsing ──────────────────────────────────────────────────

export function parseRelinkArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    if (a === '--apply') { args['apply'] = '1'; continue; }
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

export interface RelinkConfig {
  sinceHours: number;
  limit: number;
  apply: boolean;
}

export function configFromRelinkArgs(raw: Record<string, string>): RelinkConfig {
  return {
    sinceHours: parseInt(raw['sinceHours'] ?? '24', 10),
    limit: parseInt(raw['limit'] ?? '200', 10),
    apply: raw['apply'] === '1',
  };
}

// ── Article/Event types for relink ───────────────────────────────────

export interface RelinkArticle {
  id: string;
  title: string;
  url: string;
  embeddingVec: number[];
  publishedAt: Date | null;
  contentType: string | null;
  mediaId: string;
}

export interface RelinkEvent {
  id: string;
  state: string;
  canonicalEventId: string | null;
  articles: RelinkArticle[];
  qualityIssues: string[];
}

export interface RelinkResult {
  original_event_id: string;
  articles_count: number;
  quality_issues: string[];
  new_clusters: RelinkCluster[];
  action: 'SKIP_OK' | 'SKIP_ALREADY_SUPERSEDED' | 'SKIP_SINGLE_CLUSTER' | 'RELINKED';
}

export interface RelinkCluster {
  article_ids: string[];
  new_event_id: string | null; // null in dry-run
}

export interface RelinkSummary {
  mode: 'dry-run' | 'apply';
  events_scanned: number;
  events_with_issues: number;
  events_already_superseded: number;
  events_single_cluster: number;
  merges_attempted: number;
  merges_blocked: Record<string, number>;
  merges_applied: number;
  results: RelinkResult[];
}

// ── Core re-clustering logic (pure, no DB) ───────────────────────────

/**
 * Should two articles be blocked from co-linking based on current hard-negative gates?
 */
export function shouldBlockPair(a: RelinkArticle, b: RelinkArticle): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Desk mismatch
  const deskA = extractDesk(a.url);
  const deskB = extractDesk(b.url);
  if (!desksCompatible(deskA, deskB)) {
    reasons.push('DESK_MISMATCH');
  }

  // Topic mismatch with confidence
  const topicA = classifyTopic({ title: a.title, url: a.url, contentType: a.contentType });
  const topicB = classifyTopic({ title: b.title, url: b.url, contentType: b.contentType });
  if (topicA.topic_key !== topicB.topic_key) {
    if (topicA.confidence >= 0.6 && topicB.confidence >= 0.6) {
      reasons.push('TOPIC_MISMATCH_HIGH_CONF');
    }
  }

  // Title contradiction: low keyword jaccard AND low entity jaccard
  const kwA = extractTitleKeywords(a.title);
  const kwB = extractTitleKeywords(b.title);
  const kwJac = jaccardSets(kwA, kwB);
  const entA = extractTitleEntities(a.title);
  const entB = extractTitleEntities(b.title);
  const entJac = jaccardSets(entA, entB);
  if (kwJac < 0.03 && entJac < 0.02) {
    // Exception: high embedding similarity
    const embSim = cosineSimilarity(a.embeddingVec, b.embeddingVec);
    if (embSim < 0.65) {
      reasons.push('TITLE_CONTRADICTION');
    }
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * Re-cluster articles into groups using current hard-negative gates.
 * Uses greedy single-pass: for each article, try to add to an existing cluster
 * (requires no hard-negative block with ALL existing cluster members AND
 *  embedding similarity with cluster centroid >= threshold).
 *
 * Pure function, deterministic.
 */
export function reclusterArticles(
  articles: RelinkArticle[],
  embedThreshold: number = THETA_AUTO_LINK,
): RelinkCluster[] {
  if (articles.length === 0) return [];

  const clusters: RelinkArticle[][] = [[articles[0]]];

  for (let i = 1; i < articles.length; i++) {
    const art = articles[i];
    let placed = false;

    for (const cluster of clusters) {
      // Check if this article can join this cluster
      let blocked = false;
      const blockReasons: string[] = [];

      for (const member of cluster) {
        const check = shouldBlockPair(art, member);
        if (check.blocked) {
          blocked = true;
          blockReasons.push(...check.reasons);
          break;
        }
      }

      if (!blocked) {
        // Check embedding similarity with cluster centroid
        const clusterVecs = cluster.map((a) => a.embeddingVec);
        const centroid = clusterVecs.reduce(
          (acc, vec) => acc.map((v, j) => v + vec[j]),
          new Array(clusterVecs[0].length).fill(0),
        ).map((v) => v / clusterVecs.length);
        const sim = cosineSimilarity(art.embeddingVec, centroid);

        if (sim >= embedThreshold) {
          cluster.push(art);
          placed = true;
          break;
        }
      }
    }

    if (!placed) {
      clusters.push([art]);
    }
  }

  return clusters.map((cluster) => ({
    article_ids: cluster.map((a) => a.id),
    new_event_id: null,
  }));
}

// ── Event quality issue detection ────────────────────────────────────

export function detectQualityIssues(
  articles: Array<{ title?: string | null; url?: string | null; contentType?: string | null }>,
  coherenceGate?: { status?: string; metrics?: { title_jaccard?: number; entity_jaccard?: number } } | null,
): string[] {
  const issues: string[] = [];

  // Split proxy
  const splitResult = detectIntraSplitProxy(
    articles.map((a) => ({ title: a.title, url: a.url, contentType: a.contentType })),
  );
  if (splitResult.split_proxy) {
    issues.push('SPLIT_PROXY');
  }

  // Coherence gate fail
  if (coherenceGate?.status === 'FAIL') {
    issues.push('COHERENCE_FAIL');
  }

  // Low title alignment
  if (coherenceGate?.metrics?.title_jaccard != null && coherenceGate.metrics.title_jaccard < 0.10) {
    issues.push('LOW_TITLE_ALIGNMENT');
  }

  // Low entity overlap
  if (coherenceGate?.metrics?.entity_jaccard != null && coherenceGate.metrics.entity_jaccard < 0.06) {
    issues.push('LOW_ENTITY_OVERLAP');
  }

  return issues;
}

// ── Main pipeline ────────────────────────────────────────────────────

export async function runRelink(prisma: PrismaClient, config: RelinkConfig): Promise<RelinkSummary> {
  const since = new Date(Date.now() - config.sinceHours * 60 * 60 * 1000);

  const summary: RelinkSummary = {
    mode: config.apply ? 'apply' : 'dry-run',
    events_scanned: 0,
    events_with_issues: 0,
    events_already_superseded: 0,
    events_single_cluster: 0,
    merges_attempted: 0,
    merges_blocked: {},
    merges_applied: 0,
    results: [],
  };

  // Query candidate events
  const events = await prisma.event.findMany({
    where: {
      state: { in: ['PUBLISHED', 'DETECTED', 'PENDING_PUBLISH', 'UPDATING'] as any[] },
      createdAt: { gte: since },
      canonicalEventId: null,
    },
    take: config.limit,
    orderBy: { createdAt: 'desc' },
    include: {
      versions: { orderBy: { versionIndex: 'desc' as any }, take: 1 },
      eventArticles: {
        include: {
          article: {
            select: {
              id: true,
              title: true,
              url: true,
              embeddingVec: true,
              publishedAt: true,
              contentType: true,
              mediaId: true,
            },
          },
        },
      },
    },
  });

  summary.events_scanned = events.length;

  for (const ev of events) {
    const articles = ev.eventArticles.map((ea: any) => ea.article);
    if (articles.length < 3) continue; // Only process events with >= 3 articles

    // Check quality issues
    const packet = (ev.versions[0] as any)?.packetJson ?? {};
    const coherenceGate = packet.coherence_gate ?? null;
    const qualityIssues = detectQualityIssues(
      articles.map((a: any) => ({ title: a.title, url: a.url, contentType: a.contentType })),
      coherenceGate,
    );

    if (qualityIssues.length === 0) {
      summary.results.push({
        original_event_id: ev.id,
        articles_count: articles.length,
        quality_issues: [],
        new_clusters: [],
        action: 'SKIP_OK',
      });
      continue;
    }

    summary.events_with_issues++;

    // Build RelinkArticle objects
    const relinkArticles: RelinkArticle[] = articles
      .filter((a: any) => a.embeddingVec && Array.isArray(a.embeddingVec))
      .map((a: any) => ({
        id: a.id,
        title: a.title,
        url: a.url,
        embeddingVec: a.embeddingVec as number[],
        publishedAt: a.publishedAt,
        contentType: a.contentType,
        mediaId: a.mediaId,
      }));

    if (relinkArticles.length < 2) continue;

    // Re-cluster
    const newClusters = reclusterArticles(relinkArticles);
    summary.merges_attempted++;

    // Accumulate block reasons
    for (let ci = 0; ci < newClusters.length; ci++) {
      for (let cj = ci + 1; cj < newClusters.length; cj++) {
        // Check why clusters are separated
        const artA = relinkArticles.find((a) => a.id === newClusters[ci].article_ids[0]);
        const artB = relinkArticles.find((a) => a.id === newClusters[cj].article_ids[0]);
        if (artA && artB) {
          const check = shouldBlockPair(artA, artB);
          for (const reason of check.reasons) {
            summary.merges_blocked[reason] = (summary.merges_blocked[reason] ?? 0) + 1;
          }
        }
      }
    }

    // If only one cluster, original event is fine (gates don't split it)
    if (newClusters.length <= 1) {
      summary.events_single_cluster++;
      summary.results.push({
        original_event_id: ev.id,
        articles_count: articles.length,
        quality_issues: qualityIssues,
        new_clusters: newClusters,
        action: 'SKIP_SINGLE_CLUSTER',
      });
      continue;
    }

    // Multiple clusters → event needs relinking
    if (config.apply) {
      // Create new events and re-link articles
      const now = new Date();
      for (const cluster of newClusters) {
        const newEvent = await prisma.event.create({
          data: {
            state: 'DETECTED' as any,
            t0: now,
            tLast: now,
          },
        });
        cluster.new_event_id = newEvent.id;

        // Link articles to new event
        for (const artId of cluster.article_ids) {
          await prisma.eventArticle.upsert({
            where: { eventId_articleId: { eventId: newEvent.id, articleId: artId } },
            update: {},
            create: { eventId: newEvent.id, articleId: artId },
          });
        }
      }

      // Mark original event as CLOSED with canonical pointing to largest new event
      const largestCluster = newClusters.reduce((a, b) =>
        a.article_ids.length >= b.article_ids.length ? a : b,
      );
      await prisma.event.update({
        where: { id: ev.id },
        data: {
          state: 'CLOSED' as any,
          canonicalEventId: largestCluster.new_event_id,
          closedAt: now,
        },
      });

      // Write audit log
      await prisma.auditLog.create({
        data: {
          entityType: 'EVENT' as any,
          entityId: ev.id,
          action: 'RELINKED',
          traceId: `relink-${Date.now()}`,
          data: {
            original_event_id: ev.id,
            quality_issues: qualityIssues,
            new_event_ids: newClusters.map((c) => c.new_event_id),
            cluster_sizes: newClusters.map((c) => c.article_ids.length),
          },
        },
      });

      summary.merges_applied++;
    }

    summary.results.push({
      original_event_id: ev.id,
      articles_count: articles.length,
      quality_issues: qualityIssues,
      new_clusters: newClusters,
      action: config.apply ? 'RELINKED' : 'SKIP_SINGLE_CLUSTER',
    });
  }

  return summary;
}

// ── Formatting ───────────────────────────────────────────────────────

export function formatRelinkSummary(summary: RelinkSummary): string {
  const lines: string[] = [];
  lines.push(JSON.stringify({
    kind: 'relink_summary',
    mode: summary.mode,
    events_scanned: summary.events_scanned,
    events_with_issues: summary.events_with_issues,
    events_already_superseded: summary.events_already_superseded,
    events_single_cluster: summary.events_single_cluster,
    merges_attempted: summary.merges_attempted,
    merges_blocked: summary.merges_blocked,
    merges_applied: summary.merges_applied,
  }));

  for (const result of summary.results) {
    if (result.action === 'SKIP_OK') continue;
    lines.push(JSON.stringify({
      kind: 'relink_event',
      ...result,
    }));
  }

  return lines.join('\n') + '\n';
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const args = parseRelinkArgs(process.argv);
  const config = configFromRelinkArgs(args);

  process.stderr.write(`events-relink: mode=${config.apply ? 'APPLY' : 'DRY-RUN'} sinceHours=${config.sinceHours} limit=${config.limit}\n`);

  const prisma = new PrismaClient();
  try {
    const summary = await runRelink(prisma, config);
    process.stdout.write(formatRelinkSummary(summary));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  process.stderr.write(`events-relink error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
