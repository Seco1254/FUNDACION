import { FeedRepository } from '../repo/feed-repo.js';
import type { FeedCard, FeedCardOverview, FeedResponse } from '../../../contracts/product/feed-card.js';
import type { FeedCardSource, FeedCardTopic, OverviewConfidenceLabel } from '../../../contracts/product/shared.js';
import { PRODUCT_TOPIC_LABELS, PRODUCT_TOPIC_KEYS } from '../../../contracts/product/shared.js';
import { RankingService } from '../../ranking/service/ranking-service.js';
import { computeEvidenceLevel, buildWhyNoOverview } from './evidence-level.js';
import { evaluatePublishGate } from '../../../core/llm/gates.js';
import type { PublishGateResult } from '../../../core/llm/gates.js';
import { logger } from '../../../core/logging/logger.js';

// Re-export EvidenceLevel for backward compat
export type { EvidenceLevel } from './evidence-level.js';

// ── Internal types (not exposed in API) ─────────────────────

interface InternalGateInput {
  unique_sources_count: number;
  total_usable_text_len: number;
  key_facts_count: number;
  overview_status: string;
  has_disclaimer: boolean;
}

// ── Overview extraction ─────────────────────────────────────

const VALID_CONFIDENCE_LABELS = new Set<string>(['Alta', 'Media', 'Baja', 'Pendiente', 'No concluyente']);

function toConfidenceLabel(raw: unknown): OverviewConfidenceLabel {
  if (typeof raw === 'string' && VALID_CONFIDENCE_LABELS.has(raw)) {
    return raw as OverviewConfidenceLabel;
  }
  return 'No concluyente';
}

function extractOverview(packet: any): FeedCardOverview | null {
  const ai = packet?.ai_overview;
  if (!ai) return null;
  const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
  const ctx = Array.isArray(ai.context) ? ai.context : [];
  const disp = Array.isArray(ai.in_dispute) ? ai.in_dispute : [];
  if (wh.length === 0 && ctx.length === 0) return null;
  return {
    status: 'ready',
    what_happened: wh,
    context: ctx,
    in_dispute: disp,
    confidence_label: toConfidenceLabel(ai.confidence_label),
  };
}

/**
 * Derive overview status from packet data.
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
 * Deterministic fallback overview for items whose overview is not yet ready.
 */
export function buildFeedFallbackOverview(
  headline: string | null,
  sources: FeedCardSource[],
  overviewStatus: string,
): FeedCardOverview {
  const bullets: string[] = [];

  if (headline) {
    bullets.push(headline);
  }

  if (sources.length > 0) {
    const sourceNames = sources.map((s) => s.name).join(', ');
    bullets.push(`Fuentes: ${sourceNames}.`);
  }

  const statusLabel = overviewStatus === 'pending'
    ? 'Resumen en proceso.'
    : 'Evidencia en proceso de verificación.';

  bullets.push(statusLabel);

  return {
    status: overviewStatus === 'pending' ? 'pending' : 'unavailable',
    what_happened: bullets,
    context: [],
    in_dispute: [],
    confidence_label: 'Pendiente',
  };
}

// ── Topic extraction ────────────────────────────────────────

function extractTopic(row: any, packet: any): FeedCardTopic | null {
  // Source of truth: topic_assignment table (included via Prisma)
  const assignments = row.topicAssignments;
  if (Array.isArray(assignments) && assignments.length > 0) {
    const topKey = assignments[0].topicKey as string;
    if (PRODUCT_TOPIC_KEYS.has(topKey)) {
      return {
        key: topKey as FeedCardTopic['key'],
        label: PRODUCT_TOPIC_LABELS[topKey as keyof typeof PRODUCT_TOPIC_LABELS],
      };
    }
  }

  // Fallback: packetJson.topics.top_topics[0]
  const topTopics = packet?.topics?.top_topics;
  if (Array.isArray(topTopics) && topTopics.length > 0) {
    const fallbackKey = (topTopics[0].key ?? topTopics[0].topic_key) as string;
    if (fallbackKey && PRODUCT_TOPIC_KEYS.has(fallbackKey)) {
      return {
        key: fallbackKey as FeedCardTopic['key'],
        label: PRODUCT_TOPIC_LABELS[fallbackKey as keyof typeof PRODUCT_TOPIC_LABELS],
      };
    }
  }

  return null;
}

// ── Source aggregation ──────────────────────────────────────

function aggregateSources(row: any): { sources: FeedCardSource[]; sourceCount: number; articleCount: number; uniqueSourcesCount: number; usableArticlesCount: number; totalUsableTextLen: number } {
  const articles = (row.eventArticles ?? []).map((ea: any) => ea.article);
  const articleCount = articles.length;

  const mediaMap = new Map<string, { name: string; mediaKey: string }>();
  for (const a of articles) {
    const key = a.media?.mediaKey ?? 'unknown';
    if (!mediaMap.has(key)) {
      mediaMap.set(key, { name: a.media?.name ?? key, mediaKey: key });
    }
  }

  const sources: FeedCardSource[] = [...mediaMap.values()].map((v) => ({
    media_key: v.mediaKey,
    name: v.name,
  }));

  const usableArticles = articles.filter((a: any) => a.usableForOverview);
  const totalUsableTextLen = usableArticles.reduce(
    (sum: number, a: any) => sum + (a.textContentLen ?? 0), 0,
  );

  return {
    sources,
    sourceCount: mediaMap.size,
    articleCount,
    uniqueSourcesCount: mediaMap.size,
    usableArticlesCount: usableArticles.length,
    totalUsableTextLen,
  };
}

// ── Build FeedCard ──────────────────────────────────────────

/**
 * Build a product FeedCard from a DB row, applying gate and fallback logic.
 */
export function buildFeedItem(row: any): { item: FeedCard; eligible: boolean; gateReasons: string[] } {
  const latestVersion = row.versions?.[0] ?? null;
  const packet = (latestVersion?.packetJson as any) ?? {};
  const teaser: string | null = packet.ai_teaser || null;

  const headline: string = latestVersion?.headline ?? '';
  const publishedAt: string = row.publishedAt?.toISOString() ?? '';

  const { sources, sourceCount, articleCount, uniqueSourcesCount, usableArticlesCount, totalUsableTextLen } = aggregateSources(row);

  const overviewStatus = deriveOverviewStatus(packet);
  const evidenceLevel = computeEvidenceLevel(uniqueSourcesCount, totalUsableTextLen);
  const keyFactsCount: number = packet.key_facts_count ?? 0;

  // Evaluate publish gate (uses internal metrics not exposed in API)
  const ai = packet?.ai_overview;
  const hasDisclaimer = typeof ai?.why === 'string'
    && /única fuente|una fuente|una sola fuente|evidencia limitada/i.test(ai.why);

  const gateInput: InternalGateInput = {
    unique_sources_count: uniqueSourcesCount,
    total_usable_text_len: totalUsableTextLen,
    key_facts_count: keyFactsCount,
    overview_status: overviewStatus,
    has_disclaimer: hasDisclaimer,
  };
  const gate = evaluatePublishGate(gateInput);

  // Determine overview
  let overview = extractOverview(packet);
  const effectiveStatus = gate.eligible ? overviewStatus : 'unavailable';

  if (!overview) {
    overview = buildFeedFallbackOverview(headline, sources, effectiveStatus);
  }
  if (!gate.eligible) {
    overview = { ...overview, status: 'unavailable' };
  }

  // Extract topic
  const topic = extractTopic(row, packet);

  // Map evidence_level 'none' → 'low' (none is filtered by gate but just in case)
  const publicEvidenceLevel: 'high' | 'medium' | 'low' = evidenceLevel === 'none' ? 'low' : evidenceLevel;

  const item: FeedCard = {
    event_id: row.id,
    headline,
    published_at: publishedAt,
    updated_at: row.tLast?.toISOString() ?? null,
    overview,
    topic,
    sources,
    source_count: sourceCount,
    article_count: articleCount,
    evidence_level: publicEvidenceLevel,
    cover_image_url: teaser,
  };

  return { item, eligible: gate.eligible, gateReasons: gate.reasons };
}

// ── Logging ─────────────────────────────────────────────────

function logGatedItems(
  total: number,
  eligibleItems: Array<{ item: FeedCard }>,
  gatedItems: Array<{ item: FeedCard; gateReasons: string[] }>,
): void {
  if (gatedItems.length > 0) {
    logger.info({
      total,
      eligible: eligibleItems.length,
      gated: gatedItems.length,
      sample_reasons: gatedItems.slice(0, 5).map((r) => ({
        event_id: r.item.event_id,
        reasons: r.gateReasons,
      })),
    }, 'feed_publish_gate_filtered');
  }
}

// ── FeedService ─────────────────────────────────────────────

const PAGE_SIZE = 20;

type EmptyReason = 'no_events' | 'no_published';

export class FeedService {
  private rankingService: RankingService | null;
  private repo: FeedRepository;

  constructor(repo: FeedRepository, rankingService?: RankingService) {
    this.repo = repo;
    this.rankingService = rankingService ?? null;
  }

  private async diagnoseEmpty(publishedRows: number, gatedAll: boolean): Promise<EmptyReason> {
    if (gatedAll) return 'no_events';
    if (publishedRows === 0) {
      const stateCounts = await this.repo.countEventsByState();
      const total = Object.values(stateCounts).reduce((a, b) => a + b, 0);
      if (total === 0) return 'no_events';
      if (!stateCounts['PUBLISHED'] || stateCounts['PUBLISHED'] === 0) return 'no_published';
    }
    return 'no_events';
  }

  async getFeed(cursorStr?: string, topicFilter?: string): Promise<FeedResponse> {
    // When ranking is enabled and this is page 1 (no cursor), use ranked feed
    if (this.rankingService && !cursorStr && !topicFilter) {
      return this.getRankedFeed();
    }

    // Fallback: chronological feed (also used for pagination after page 1)
    return this.getChronologicalFeed(cursorStr, topicFilter);
  }

  private async getRankedFeed(): Promise<FeedResponse> {
    // Fetch a larger window for ranking (top 60 events, rank, return top 20)
    const RANK_WINDOW = 60;
    const rows = await this.repo.getFeed(undefined, RANK_WINDOW);

    if (rows.length === 0) {
      const empty_reason = await this.diagnoseEmpty(0, false);
      return { items: [], next_cursor: null, meta: { has_more: false, empty_reason } };
    }

    const scored = await this.rankingService!.rankPublishedEvents(rows as any);

    // Map scored results back to rows
    const rowMap = new Map(rows.map((r: any) => [r.id, r]));
    const rankedRows = scored
      .map((s) => rowMap.get(s.eventId))
      .filter((r): r is NonNullable<typeof r> => r != null);

    const allRankedItems = rankedRows.map((row: any) => buildFeedItem(row));
    const eligible = allRankedItems.filter((r) => r.eligible);
    const gated = allRankedItems.filter((r) => !r.eligible);
    logGatedItems(allRankedItems.length, eligible, gated);

    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    // Cursor for page 2+: fall back to chronological after ranked page 1
    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastItem = eligible[PAGE_SIZE - 1].item;
      const lastRow = rankedRows.find((r: any) => r.id === lastItem.event_id);
      const ts = lastRow?.publishedAt?.toISOString() ?? lastRow?.createdAt?.toISOString() ?? new Date().toISOString();
      next_cursor = Buffer.from(`${ts}|${lastItem.event_id}`).toString('base64');
    }

    if (feedItems.length === 0) {
      const empty_reason = await this.diagnoseEmpty(rows.length, gated.length > 0 && eligible.length === 0);
      return { items: [], next_cursor: null, meta: { has_more: false, empty_reason } };
    }

    return { items: feedItems, next_cursor, meta: { has_more: next_cursor !== null } };
  }

  private async getChronologicalFeed(cursorStr?: string, topicFilter?: string): Promise<FeedResponse> {
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
    const rows = await this.repo.getFeed(cursor, OVER_FETCH, topicFilter);

    const allItems = rows.map((row: any) => buildFeedItem(row));
    const eligible = allItems.filter((r) => r.eligible);
    const gated = allItems.filter((r) => !r.eligible);
    logGatedItems(allItems.length, eligible, gated);

    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastItem = eligible[PAGE_SIZE - 1].item;
      const lastRow = rows.find((r: any) => r.id === lastItem.event_id) ?? rows[rows.length - 1];
      const ts = lastRow?.publishedAt?.toISOString() ?? lastRow?.createdAt?.toISOString() ?? new Date().toISOString();
      next_cursor = Buffer.from(`${ts}|${lastItem.event_id}`).toString('base64');
    }

    if (feedItems.length === 0) {
      const empty_reason = await this.diagnoseEmpty(rows.length, gated.length > 0 && eligible.length === 0);
      return { items: [], next_cursor: null, meta: { has_more: false, empty_reason } };
    }

    return { items: feedItems, next_cursor, meta: { has_more: next_cursor !== null } };
  }
}
