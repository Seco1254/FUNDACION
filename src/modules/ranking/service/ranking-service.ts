/**
 * RankingService: computes ranked feed by loading events with articles,
 * scoring them, and returning sorted results.
 *
 * This service is injected into FeedService to replace pure-chronological ordering
 * with multi-feature ranking while preserving cursor-based pagination.
 */

import { EventRepository } from '../../events/repo/event-repo.js';
import { computeEventScore, rankEvents, EventForScoring, ScoredEvent } from './event-scorer.js';
import { JUNK_EXCLUDE_THRESHOLD } from './junk-scorer.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { logger } from '../../../core/logging/logger.js';

export class RankingService {
  constructor(private eventRepo: EventRepository) {}

  /**
   * Score and rank published events. Returns ordered event IDs.
   * Called by FeedService to replace chronological sort with ranking.
   */
  async rankPublishedEvents(
    rawEvents: Array<{
      id: string;
      state: string;
      publishedAt: Date | null;
      tLast: Date | null;
      t0: Date | null;
      createdAt: Date;
      versions: Array<{ headline: string | null }>;
    }>,
  ): Promise<ScoredEvent[]> {
    const now = new Date();
    const startMs = Date.now();

    const eventsForScoring: EventForScoring[] = [];

    for (const raw of rawEvents) {
      const articles = await this.eventRepo.findArticlesForEvent(raw.id);
      const scoringArticles = articles.map((a: any) => ({
        id: a.id,
        url: a.url,
        title: a.title,
        snippet: a.snippet,
        mediaId: a.mediaId,
        publishedAt: a.publishedAt,
        createdAt: a.createdAt,
      }));

      // Extract topic keys from latest version (stored in packetJson)
      const latestVersion = raw.versions?.[0] ?? null;
      const packet = (latestVersion as any)?.packetJson ?? {};
      const topicKeys: string[] = Array.isArray(packet.topic_keys) ? packet.topic_keys : [];

      eventsForScoring.push({
        id: raw.id,
        publishedAt: raw.publishedAt,
        tLast: raw.tLast,
        t0: raw.t0,
        articles: scoringArticles,
        headline: latestVersion?.headline ?? null,
        topicKeys,
      });
    }

    const ranked = rankEvents(eventsForScoring, now);

    // ── Metrics ──
    const durationMs = Date.now() - startMs;
    metrics.observeHistogram('ranking.score_duration_ms', durationMs);

    const top10 = ranked.slice(0, 10);
    if (top10.length > 0) {
      const avgScore = top10.reduce((s, r) => s + r.score, 0) / top10.length;
      metrics.setGauge('ranking.avg_score_top10', avgScore);

      // Multi-source ratio in top 10
      const multiSourceCount = eventsForScoring
        .filter((e) => top10.some((r) => r.eventId === e.id))
        .filter((e) => new Set(e.articles.map((a) => a.mediaId)).size > 1)
        .length;
      metrics.setGauge('ranking.top_feed_multi_source_ratio', multiSourceCount / top10.length);
    }

    const junkBlocked = rawEvents.length - ranked.length;
    if (junkBlocked > 0) {
      metrics.incCounter('ranking.junk_blocked_total', junkBlocked);
    }

    const penalized = ranked.filter((r) => r.components.junkPenalty > 0).length;
    if (penalized > 0) {
      metrics.incCounter('ranking.junk_penalized_total', penalized);
    }

    logger.info({
      total_events: rawEvents.length,
      ranked_events: ranked.length,
      junk_blocked: junkBlocked,
      duration_ms: durationMs,
    }, 'ranking_complete');

    return ranked;
  }
}
