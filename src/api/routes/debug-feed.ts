import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { FeedRepository } from '../../modules/feed/repo/feed-repo.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { ArticleRepository } from '../../modules/articles/repo/article-repo.js';
import { evaluatePublishGate } from '../../core/llm/gates.js';
import { computeEvidenceLevel, buildWhyNoOverview } from '../../modules/feed/service/evidence-level.js';

const MAX_EVENTS = 50;

interface FeedStatsItem {
  event_id: string;
  state: string;
  headline: string | null;
  overview_status: string;
  gate_pass: boolean;
  gate_reasons: string[];
  unique_sources_count: number;
  total_usable_text_len: number;
  key_facts_count: number;
  evidence_level: string;
  why_no_overview: string | null;
  published_at: string | null;
}

function deriveOverviewStatus(packet: any): 'ready' | 'unavailable' | 'pending' {
  const ai = packet?.ai_overview;
  if (!ai) return 'pending';
  const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
  const ctx = Array.isArray(ai.context) ? ai.context : [];
  if (wh.length > 0 || ctx.length > 0) return 'ready';
  return 'unavailable';
}

export function debugFeedRoutes(
  feedRepo: FeedRepository,
  eventRepo?: EventRepository,
  articleRepo?: ArticleRepository,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/feed/stats', async (_request, reply) => {
      const rows = await feedRepo.getFeed(undefined, MAX_EVENTS);

      // Pipeline breakdown (if repos available)
      const now = new Date();
      const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      let pipeline: Record<string, unknown> | null = null;
      if (eventRepo && articleRepo) {
        const [eventsByState, articleStats, oldestPendingPublishAt] = await Promise.all([
          eventRepo.countByState(),
          articleRepo.countSince(since24h),
          eventRepo.oldestPendingPublishAt(),
        ]);

        pipeline = {
          now: now.toISOString(),
          articles_last_24h: articleStats.total,
          articles_by_status_last_24h: articleStats.byStatus,
          discovered_articles_last_24h: articleStats.byStatus['DISCOVERED'] ?? 0,
          normalized_articles_last_24h: articleStats.byStatus['NORMALIZED'] ?? 0,
          policy_ok_last_24h: articleStats.byStatus['POLICY_OK'] ?? 0,
          policy_blocked_last_24h: articleStats.byStatus['POLICY_BLOCKED'] ?? 0,
          events_total: Object.values(eventsByState).reduce((a, b) => a + b, 0),
          events_by_state: eventsByState,
          oldest_pending_publish_at: oldestPendingPublishAt?.toISOString() ?? null,
          pending_is_due: oldestPendingPublishAt ? oldestPendingPublishAt <= now : null,
        };
      }

      // Gate analysis on published events
      let gateFilteredCount = 0;
      const reasonCounts = new Map<string, number>();
      const items: FeedStatsItem[] = [];
      const gateFailExamples: Array<{
        event_id: string;
        reasons: string[];
        text_len: number;
        sources: number;
        overview_status: string;
      }> = [];

      for (const row of rows as any[]) {
        const latestVersion = row.versions?.[0] ?? null;
        const packet = (latestVersion?.packetJson as any) ?? {};
        const articles = (row.eventArticles ?? []).map((ea: any) => ea.article);

        const uniqueMediaKeys = new Set(articles.map((a: any) => a.media?.mediaKey ?? 'unknown'));
        const uniqueSourcesCount = uniqueMediaKeys.size;
        const usableArticles = articles.filter((a: any) => a.usableForOverview);
        const usableArticlesCount = usableArticles.length;
        const totalUsableTextLen = usableArticles.reduce(
          (sum: number, a: any) => sum + (a.textContentLen ?? 0), 0,
        );
        const keyFactsCount: number = packet.key_facts_count ?? 0;
        const overviewStatus = deriveOverviewStatus(packet);
        const evidenceLevel = computeEvidenceLevel(uniqueSourcesCount, totalUsableTextLen);

        const ai = packet?.ai_overview;
        const hasDisclaimer = typeof ai?.why === 'string' && /única fuente|una fuente|una sola fuente|evidencia limitada/i.test(ai.why);

        const gate = evaluatePublishGate({
          unique_sources_count: uniqueSourcesCount,
          total_usable_text_len: totalUsableTextLen,
          key_facts_count: keyFactsCount,
          overview_status: overviewStatus,
          has_disclaimer: hasDisclaimer,
        });

        const failReasons = articles
          .map((a: any) => a.extractionFailReason)
          .filter(Boolean) as string[];

        const whyNoOverview = buildWhyNoOverview({
          overviewStatus: gate.eligible ? overviewStatus : 'failed',
          uniqueSourcesCount,
          usableArticlesCount,
          totalUsableTextLen,
          articleFailReasons: failReasons,
          keyFactsCount,
          gateReasons: gate.eligible ? undefined : gate.reasons,
        });

        if (!gate.eligible) {
          gateFilteredCount++;
          for (const r of gate.reasons) {
            reasonCounts.set(r, (reasonCounts.get(r) ?? 0) + 1);
          }
          if (gateFailExamples.length < 10) {
            gateFailExamples.push({
              event_id: row.id,
              reasons: gate.reasons,
              text_len: totalUsableTextLen,
              sources: uniqueSourcesCount,
              overview_status: overviewStatus,
            });
          }
        }

        items.push({
          event_id: row.id,
          state: row.state,
          headline: latestVersion?.headline ?? null,
          overview_status: gate.eligible ? overviewStatus : 'failed',
          gate_pass: gate.eligible,
          gate_reasons: gate.reasons,
          unique_sources_count: uniqueSourcesCount,
          total_usable_text_len: totalUsableTextLen,
          key_facts_count: keyFactsCount,
          evidence_level: evidenceLevel,
          why_no_overview: whyNoOverview,
          published_at: row.publishedAt?.toISOString() ?? null,
        });
      }

      // Top 10 filter reasons
      const topReasons = [...reasonCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([reason, count]) => ({ reason, count }));

      return reply.send({
        pipeline,
        totals: {
          published_total: rows.length,
          feed_returned_count: rows.length - gateFilteredCount,
          gate_filtered_count: gateFilteredCount,
        },
        top_filter_reasons: topReasons,
        gate_fail_examples: gateFailExamples,
        events: items,
      });
    });

    done();
  };
}
