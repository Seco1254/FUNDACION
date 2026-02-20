import { FeedRepository } from '../repo/feed-repo.js';
import { FeedItem, FeedItemOverview, FeedItemSource, FeedResponse } from '../domain/types.js';
import { RankingService } from '../../ranking/service/ranking-service.js';
import { computeEvidenceLevel, buildWhyNoOverview } from './evidence-level.js';
import { evaluatePublishGate } from '../../../core/llm/gates.js';
import type { PublishGateResult } from '../../../core/llm/gates.js';
import { logger } from '../../../core/logging/logger.js';

function extractAiOverview(packet: any): FeedItemOverview | null {
  const ai = packet?.ai_overview;
  if (!ai) return null;
  const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
  const ctx = Array.isArray(ai.context) ? ai.context : [];
  const disp = Array.isArray(ai.in_dispute) ? ai.in_dispute : [];
  const label = typeof ai.confidence_label === 'string' ? ai.confidence_label : 'No concluyente';
  if (wh.length === 0 && ctx.length === 0) return null;
  return { what_happened: wh, context: ctx, in_dispute: disp, confidence_label: label };
}

/**
 * Derive overview_status for the feed item so the client can distinguish states.
 * - 'ready': ai_overview is populated and usable
 * - 'unavailable': pipeline ran but produced no usable overview (gate FAIL, insufficient evidence)
 * - 'pending': pipeline hasn't run yet
 */
function deriveOverviewStatus(packet: any): 'ready' | 'unavailable' | 'pending' {
  const ai = packet?.ai_overview;
  if (!ai) return 'pending';
  const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
  const ctx = Array.isArray(ai.context) ? ai.context : [];
  if (wh.length > 0 || ctx.length > 0) return 'ready';
  return 'unavailable';
}

/**
 * Compute event-level observability fields from the included articles.
 */
function enrichFeedItem(row: any, packet: any): Partial<FeedItem> {
  const articles = (row.eventArticles ?? []).map((ea: any) => ea.article);
  const articleCount = articles.length;

  const mediaMap = new Map<string, { id: string; name: string; domain: string; count: number }>();
  for (const a of articles) {
    const key = a.media?.mediaKey ?? 'unknown';
    const existing = mediaMap.get(key);
    if (existing) {
      existing.count++;
    } else {
      let domain = key;
      try { domain = new URL(a.url).hostname; } catch { /* keep key */ }
      mediaMap.set(key, {
        id: a.media?.id ?? '',
        name: a.media?.name ?? key,
        domain,
        count: 1,
      });
    }
  }

  const sources: FeedItemSource[] = [...mediaMap.values()].map((v) => ({
    source_id: v.id,
    name: v.name,
    domain: v.domain,
    article_count: v.count,
  }));

  const uniqueSourcesCount = mediaMap.size;
  const usableArticles = articles.filter((a: any) => a.usableForOverview);
  const usableArticlesCount = usableArticles.length;
  const totalUsableTextLen = usableArticles.reduce(
    (sum: number, a: any) => sum + (a.textContentLen ?? 0), 0,
  );

  const overviewStatus = deriveOverviewStatus(packet);
  const evidenceLevel = computeEvidenceLevel(uniqueSourcesCount, totalUsableTextLen);
  const overviewMode: string | null = packet.overview_mode ?? null;

  const failReasons = articles
    .map((a: any) => a.extractionFailReason)
    .filter(Boolean) as string[];

  const keyFactsCount: number = packet.key_facts_count ?? 0;

  const whyNoOverview = buildWhyNoOverview({
    overviewStatus,
    uniqueSourcesCount,
    usableArticlesCount,
    totalUsableTextLen,
    articleFailReasons: failReasons,
    keyFactsCount,
  });

  return {
    sources,
    article_count: articleCount,
    unique_sources_count: uniqueSourcesCount,
    usable_articles_count: usableArticlesCount,
    total_usable_text_len: totalUsableTextLen,
    key_facts_count: keyFactsCount,
    evidence_level: evidenceLevel,
    overview_mode: overviewMode,
    why_no_overview: whyNoOverview,
  };
}

/**
 * Apply the publish gate to a feed item.
 * Returns the gate result and optionally mutates item to 'failed' status.
 */
function applyPublishGate(item: FeedItem, packet: any): PublishGateResult {
  const ai = packet?.ai_overview;
  const hasDisclaimer = typeof ai?.why === 'string' && /única fuente|una fuente/i.test(ai.why);

  const gateResult = evaluatePublishGate({
    unique_sources_count: item.unique_sources_count ?? 0,
    total_usable_text_len: item.total_usable_text_len ?? 0,
    key_facts_count: item.key_facts_count ?? 0,
    overview_status: item.overview_status ?? 'pending',
    has_disclaimer: hasDisclaimer,
  });

  if (!gateResult.eligible) {
    item.overview_status = 'failed';
    item.why_no_overview = buildWhyNoOverview({
      overviewStatus: 'failed',
      uniqueSourcesCount: item.unique_sources_count ?? 0,
      usableArticlesCount: item.usable_articles_count ?? 0,
      totalUsableTextLen: item.total_usable_text_len ?? 0,
      articleFailReasons: [],
      keyFactsCount: item.key_facts_count ?? 0,
      gateReasons: gateResult.reasons,
    });
  }

  return gateResult;
}

const PAGE_SIZE = 20;

export class FeedService {
  private rankingService: RankingService | null;
  private repo: FeedRepository;

  constructor(repo: FeedRepository, rankingService?: RankingService) {
    this.repo = repo;
    this.rankingService = rankingService ?? null;
  }

  async getFeed(cursorStr?: string): Promise<FeedResponse> {
    // When ranking is enabled and this is page 1 (no cursor), use ranked feed
    if (this.rankingService && !cursorStr) {
      return this.getRankedFeed();
    }

    // Fallback: chronological feed (also used for pagination after page 1)
    return this.getChronologicalFeed(cursorStr);
  }

  private async getRankedFeed(): Promise<FeedResponse> {
    // Fetch a larger window for ranking (top 60 events, rank, return top 20)
    const RANK_WINDOW = 60;
    const rows = await this.repo.getFeed(undefined, RANK_WINDOW);

    if (rows.length === 0) {
      return { items: [], next_cursor: null };
    }

    const scored = await this.rankingService!.rankPublishedEvents(rows as any);

    // Map scored results back to rows
    const rowMap = new Map(rows.map((r: any) => [r.id, r]));
    const rankedRows = scored
      .map((s) => rowMap.get(s.eventId))
      .filter((r): r is NonNullable<typeof r> => r != null);

    const allRankedItems: Array<{ item: FeedItem; row: any; eligible: boolean; gateReasons: string[] }> = rankedRows.map((row: any) => {
      const latestVersion = row.versions?.[0] ?? null;
      const packet = (latestVersion?.packetJson as any) ?? {};
      const teaser: string | null = packet.ai_teaser || null;
      const item: FeedItem = {
        event_id: row.id,
        state: row.state,
        headline: latestVersion?.headline ?? null,
        t_last: row.tLast?.toISOString() ?? null,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: teaser,
        ai_overview: extractAiOverview(packet),
        overview_status: deriveOverviewStatus(packet),
        ...enrichFeedItem(row, packet),
      };
      const gate = applyPublishGate(item, packet);
      return { item, row, eligible: gate.eligible, gateReasons: gate.reasons };
    });

    const eligible = allRankedItems.filter((r) => r.eligible);
    const gated = allRankedItems.filter((r) => !r.eligible);
    if (gated.length > 0) {
      logger.info({
        total: allRankedItems.length,
        eligible: eligible.length,
        gated: gated.length,
        sample_reasons: gated.slice(0, 5).map((r) => ({
          event_id: r.item.event_id,
          reasons: r.gateReasons,
          overview_status: r.item.overview_status,
          sources: r.item.unique_sources_count,
          text_len: r.item.total_usable_text_len,
        })),
      }, 'feed_publish_gate_filtered');
    }
    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    // Cursor for page 2+: fall back to chronological after ranked page 1
    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastRow = eligible[PAGE_SIZE - 1].row;
      const ts = lastRow.publishedAt?.toISOString() ?? lastRow.createdAt.toISOString();
      next_cursor = Buffer.from(`${ts}|${lastRow.id}`).toString('base64');
    }

    return { items: feedItems, next_cursor };
  }

  private async getChronologicalFeed(cursorStr?: string): Promise<FeedResponse> {
    let cursor: { publishedAt: Date; eventId: string } | undefined;

    if (cursorStr) {
      const decoded = Buffer.from(cursorStr, 'base64').toString('utf-8');
      const [publishedAtStr, eventId] = decoded.split('|');
      if (publishedAtStr && eventId) {
        cursor = { publishedAt: new Date(publishedAtStr), eventId };
      }
    }

    // Over-fetch to compensate for gate-filtered items
    const OVER_FETCH = PAGE_SIZE * 3;
    const rows = await this.repo.getFeed(cursor, OVER_FETCH);

    const allItems: Array<{ item: FeedItem; row: any; eligible: boolean; gateReasons: string[] }> = rows.map((row: any) => {
      const latestVersion = row.versions?.[0] ?? null;
      const packet = (latestVersion?.packetJson as any) ?? {};
      const teaser: string | null = packet.ai_teaser || null;
      const item: FeedItem = {
        event_id: row.id,
        state: row.state,
        headline: latestVersion?.headline ?? null,
        t_last: row.tLast?.toISOString() ?? null,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: teaser,
        ai_overview: extractAiOverview(packet),
        overview_status: deriveOverviewStatus(packet),
        ...enrichFeedItem(row, packet),
      };
      const gate = applyPublishGate(item, packet);
      return { item, row, eligible: gate.eligible, gateReasons: gate.reasons };
    });

    const eligible = allItems.filter((r) => r.eligible);
    const gated = allItems.filter((r) => !r.eligible);
    if (gated.length > 0) {
      logger.info({
        total: allItems.length,
        eligible: eligible.length,
        gated: gated.length,
        sample_reasons: gated.slice(0, 5).map((r) => ({
          event_id: r.item.event_id,
          reasons: r.gateReasons,
          overview_status: r.item.overview_status,
          sources: r.item.unique_sources_count,
          text_len: r.item.total_usable_text_len,
        })),
      }, 'feed_publish_gate_filtered');
    }
    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastRow = eligible[PAGE_SIZE - 1].row;
      const ts = lastRow.publishedAt?.toISOString() ?? lastRow.createdAt.toISOString();
      next_cursor = Buffer.from(`${ts}|${lastRow.id}`).toString('base64');
    }

    return { items: feedItems, next_cursor };
  }
}
