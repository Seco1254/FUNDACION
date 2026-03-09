import { FeedRepository } from '../repo/feed-repo.js';
import { FeedItem, FeedItemOverview, FeedItemSource, FeedResponse, EmptyReason } from '../domain/types.js';
import { RankingService } from '../../ranking/service/ranking-service.js';
import { computeEvidenceLevel, buildWhyNoOverview } from './evidence-level.js';
import { evaluatePublishGate, computeImportanceScore, computeDemotionMultiplier, computePublicImportanceV3 } from '../../../core/llm/gates.js';
import type { PublishGateResult } from '../../../core/llm/gates.js';
import { aggregateEventTopic } from '../../topics/service/topic-heuristic.js';
import { detectIntraSplitProxy } from '../../quality/detectors/intra-split-proxy.js';
import { logger } from '../../../core/logging/logger.js';

// ── Topic filter config ──────────────────────────────────────────────
const FEED_TOPIC_FILTER_ENABLED = process.env.FEED_TOPIC_FILTER_ENABLED === '1';
const FEED_ALLOWED_TOPICS: string[] = (process.env.FEED_ALLOWED_TOPICS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Split proxy quarantine config ────────────────────────────────────
const FEED_SPLIT_PROXY_QUARANTINE_ENABLED = process.env.FEED_SPLIT_PROXY_QUARANTINE_ENABLED !== '0';

function extractAiOverview(packet: any): FeedItemOverview | null {
  const ai = packet?.ai_overview;
  if (!ai) return null;
  const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
  const ctx = Array.isArray(ai.context) ? ai.context : [];
  const disp = Array.isArray(ai.in_dispute) ? ai.in_dispute : [];
  const label = typeof ai.confidence_label === 'string' ? ai.confidence_label : 'No concluyente';
  if (wh.length === 0 && ctx.length === 0) return null;

  const result: FeedItemOverview = { what_happened: wh, context: ctx, in_dispute: disp, confidence_label: label };

  // Pass through or build overview paragraph
  if (typeof ai.overview === 'string' && ai.overview.trim().length > 0) {
    result.overview = ai.overview;
  } else {
    // Fallback: build narrative paragraph from what_happened bullets
    const fallbackParagraph = buildNarrativeFallback(wh, ctx);
    if (fallbackParagraph) {
      result.overview = fallbackParagraph;
    }
  }

  // Pass through analisis_fuentes if present (backward compatible)
  if (ai.analisis_fuentes && typeof ai.analisis_fuentes === 'object') {
    const af = ai.analisis_fuentes;
    result.analisis_fuentes = {
      consenso: Array.isArray(af.consenso) ? af.consenso : [],
      desacuerdo: Array.isArray(af.desacuerdo) ? af.desacuerdo : [],
      informacion_faltante: Array.isArray(af.informacion_faltante) ? af.informacion_faltante : [],
    };
  }

  return result;
}

const CONNECTORS = [' Además, ', ' Por otra parte, ', ' Asimismo, ', ' También, ', ' De igual manera, '];
const MIN_FALLBACK_WORDS = 90;

/**
 * Build a narrative paragraph from what_happened bullets + context as fallback
 * when the LLM overview is missing or empty. Produces 3-5 sentences with connectors.
 * Returns null if not enough content to reach a reasonable paragraph.
 */
export function buildNarrativeFallback(whatHappened: string[], context: string[]): string | null {
  // Collect candidate sentences (what_happened first, then context)
  const candidates = [...whatHappened, ...context].filter(
    (s) => typeof s === 'string' && s.trim().length > 0,
  );
  if (candidates.length === 0) return null;

  // Take up to 5 sentences to build the paragraph
  const sentences = candidates.slice(0, 5);
  if (sentences.length < 2) {
    // Single sentence — only viable if it's long enough
    const single = sentences[0].trim();
    const wordCount = single.split(/\s+/).length;
    return wordCount >= MIN_FALLBACK_WORDS ? single : null;
  }

  // Join with connectors
  const parts: string[] = [sentences[0].replace(/\.\s*$/, '') + '.'];
  for (let i = 1; i < sentences.length; i++) {
    const connector = CONNECTORS[(i - 1) % CONNECTORS.length];
    const sentence = sentences[i].replace(/^\s*/, '').replace(/\.\s*$/, '') + '.';
    // Lowercase first char after connector (unless proper noun)
    const firstChar = sentence[0];
    const lowered = firstChar === firstChar.toUpperCase() && /^[A-ZÁÉÍÓÚÑ]/.test(firstChar)
      ? sentence // keep uppercase (likely proper noun or start of sentence)
      : sentence[0].toLowerCase() + sentence.slice(1);
    parts.push(connector + lowered);
  }

  const paragraph = parts.join('');
  const wordCount = paragraph.split(/\s+/).length;
  return wordCount >= 15 ? paragraph : null; // At least a reasonable length
}

// ── Institutional Event Eligibility ─────────────────────────────────

/**
 * Determine if an event is dominated by institutional/static content
 * and should be excluded from the feed.
 *
 * Rules:
 * - If all articles are institutional_static and no news articles => exclude
 * - If institutional_static >= 70% and no news articles => exclude
 * - If all articles are institutional (convocatoria) and no news => exclude
 */
export function isInstitutionalEvent(row: any): { excluded: boolean; reason: string } {
  const articles = (row.eventArticles ?? []).map((ea: any) => ea.article);
  const totalArticles = articles.length;

  if (totalArticles === 0) return { excluded: false, reason: '' };

  let newsCount = 0;
  let institutionalStaticCount = 0;
  let institutionalCount = 0;

  for (const a of articles) {
    const ct = a.contentType ?? 'unknown';
    if (ct === 'news') newsCount++;
    else if (ct === 'institutional_static') institutionalStaticCount++;
    else if (ct === 'institutional') institutionalCount++;
  }

  // Rule 1: All articles are institutional_static, no news => exclude
  if (institutionalStaticCount >= 1 && newsCount === 0 && institutionalCount === 0) {
    return { excluded: true, reason: 'ALL_INSTITUTIONAL_STATIC' };
  }

  // Rule 2: institutional_static dominates (>= 70%) and no news => exclude
  if (newsCount === 0 && institutionalStaticCount > 0) {
    const staticPct = institutionalStaticCount / totalArticles;
    if (staticPct >= 0.7) {
      return { excluded: true, reason: 'INSTITUTIONAL_STATIC_DOMINANT' };
    }
  }

  // Rule 3: All institutional (convocatoria etc.) and no news => exclude
  if (newsCount === 0 && (institutionalCount + institutionalStaticCount) === totalArticles && totalArticles >= 1) {
    return { excluded: true, reason: 'ALL_INSTITUTIONAL' };
  }

  return { excluded: false, reason: '' };
}

/**
 * Deterministic fallback overview for items whose overview is not yet ready.
 * Uses headline + source names. No LLM — pure string construction.
 */
export function buildFeedFallbackOverview(
  headline: string | null,
  sources: FeedItemSource[],
  overviewStatus: string,
): FeedItemOverview {
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
    what_happened: bullets,
    context: [],
    in_dispute: [],
    confidence_label: 'Pendiente',
  };
}

/**
 * Derive overview_status for the feed item so the client can distinguish states.
 * Uses overview_lifecycle if present (v3), falls back to content inspection.
 * - 'ready': ai_overview is populated and usable
 * - 'unavailable': pipeline ran but produced no usable overview (gate FAIL, insufficient evidence)
 * - 'pending': pipeline hasn't run yet or is in progress
 * - 'failed': overview generation failed (may retry)
 */
function deriveOverviewStatus(packet: any): 'ready' | 'unavailable' | 'pending' | 'failed' {
  const lc = packet?.overview_lifecycle;
  if (lc && typeof lc === 'object' && typeof lc.status === 'string') {
    switch (lc.status) {
      case 'READY': return 'ready';
      case 'SKIPPED': return 'unavailable';
      case 'FAILED': return 'failed';
      case 'PENDING': return 'pending';
      case 'NOT_REQUESTED': return 'pending';
    }
  }
  // Backward compat: inspect ai_overview content
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
function applyPublishGate(
  item: FeedItem,
  packet: any,
  row?: any,
  importanceScore?: number,
  topicKey?: string | null,
  topicConfidence?: number | null,
): PublishGateResult {
  const ai = packet?.ai_overview;
  const hasDisclaimer = typeof ai?.why === 'string'
    && /única fuente|una fuente|una sola fuente|evidencia limitada/i.test(ai.why);

  // Extract page_types from articles (contentType maps to page_type heuristic)
  // Since non-article pages are blocked at ingestion, all surviving articles are ARTICLE.
  // This serves as defense-in-depth for any that slip through.
  const pageTypes: string[] | undefined = row?.eventArticles
    ? (row.eventArticles as any[]).map((ea: any) => {
        const ct = ea.article?.contentType;
        // Map contentType to page_type for publish gate (best-effort without URL re-analysis)
        if (ct === 'institutional_static' || ct === 'institutional') return ct;
        return 'ARTICLE';
      })
    : undefined;

  // Extract title_alignment from coherence metrics if available
  const coherenceGate = packet?.coherence_gate;
  const titleAlignment: number | null = coherenceGate?.metrics?.title_jaccard ?? null;

  // Evidence fields for title_align bypass — read from quality_flags (populated by claim extraction)
  const supportedCount: number =
    packet?.quality_flags?.supported_count ??
    packet?.claims_supported_count ??
    packet?.facts_packet?.supported_count ??
    0;
  const evidenceRate: number =
    packet?.quality_flags?.evidence_rate ??
    packet?.evidence_rate ??
    0;

  const gateResult = evaluatePublishGate({
    unique_sources_count: item.unique_sources_count ?? 0,
    total_usable_text_len: item.total_usable_text_len ?? 0,
    key_facts_count: item.key_facts_count ?? 0,
    overview_status: item.overview_status ?? 'pending',
    has_disclaimer: hasDisclaimer,
    page_types: pageTypes,
    title_alignment: titleAlignment,
    importance_score: importanceScore ?? null,
    topic_key: topicKey ?? null,
    topic_confidence: topicConfidence ?? null,
    allowed_topics: FEED_ALLOWED_TOPICS.length > 0 ? FEED_ALLOWED_TOPICS : undefined,
    headline: item.headline,
    supported_count: supportedCount,
    evidence_rate: evidenceRate,
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

/**
 * Build a FeedItem from a DB row, applying gate and fallback logic.
 */
function buildFeedItem(row: any): { item: FeedItem; eligible: boolean; gateReasons: string[] } {
  // ── Coherence gate (block incoherent clusters) ─────────────────────
  const latestVersionForCoherence = row.versions?.[0] ?? null;
  const packetForCoherence = (latestVersionForCoherence?.packetJson as any) ?? {};
  const coherenceGate = packetForCoherence.coherence_gate;
  if (coherenceGate && coherenceGate.status === 'FAIL') {
    const minimalItem: FeedItem = {
      event_id: row.id,
      state: row.state,
      headline: latestVersionForCoherence?.headline ?? null,
      t_last: row.tLast?.toISOString() ?? null,
      published_at: row.publishedAt?.toISOString() ?? null,
      cover_image_url: null,
      overview_status: 'failed',
      why_no_overview: `Coherence gate failed: ${coherenceGate.failed_checks?.join(', ') ?? 'unknown'}`,
    };
    return { item: minimalItem, eligible: false, gateReasons: ['COHERENCE_GATE_FAILED', ...(coherenceGate.failed_checks ?? [])] };
  }

  // ── Institutional content gate (before building the full item) ─────
  const institutionalCheck = isInstitutionalEvent(row);
  if (institutionalCheck.excluded) {
    // Build a minimal item for logging but mark as ineligible
    const latestVersion = row.versions?.[0] ?? null;
    const minimalItem: FeedItem = {
      event_id: row.id,
      state: row.state,
      headline: latestVersion?.headline ?? null,
      t_last: row.tLast?.toISOString() ?? null,
      published_at: row.publishedAt?.toISOString() ?? null,
      cover_image_url: null,
    };
    return { item: minimalItem, eligible: false, gateReasons: [institutionalCheck.reason] };
  }

  // ── Split proxy quarantine gate ─────────────────────────────────
  if (FEED_SPLIT_PROXY_QUARANTINE_ENABLED) {
    const splitArticles = (row.eventArticles ?? []).map((ea: any) => ({
      title: ea.article?.title ?? null,
      url: ea.article?.url ?? null,
      contentType: ea.article?.contentType ?? null,
    }));
    const splitResult = detectIntraSplitProxy(splitArticles);
    if (splitResult.split_proxy) {
      const latestV = row.versions?.[0] ?? null;
      const minimalItem: FeedItem = {
        event_id: row.id,
        state: row.state,
        headline: latestV?.headline ?? null,
        t_last: row.tLast?.toISOString() ?? null,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: null,
        overview_status: 'failed',
        why_no_overview: `Split proxy quarantine: ${splitResult.reasons.join(', ')}`,
      };
      return { item: minimalItem, eligible: false, gateReasons: ['SPLIT_PROXY_QUARANTINE', ...splitResult.reasons] };
    }
  }

  const latestVersion = row.versions?.[0] ?? null;
  const packet = (latestVersion?.packetJson as any) ?? {};

  // ── Topic classification (multi-article voting) ─────────────────
  const headline = latestVersion?.headline ?? '';
  const aiWhText = Array.isArray(packet.ai_overview?.what_happened)
    ? packet.ai_overview.what_happened.join(' ')
    : '';
  const articleInputs = (row.eventArticles ?? []).map((ea: any) => ({
    title: ea.article?.title ?? null,
    url: ea.article?.url ?? null,
    contentType: ea.article?.contentType ?? null,
  }));
  const topicResult = aggregateEventTopic(headline, articleInputs, aiWhText || null);
  const topicKey = topicResult.topic_key;
  const topicConfidence = topicResult.topic_confidence;

  // ── Topic filter (early exit before building full item) ──────────
  if (FEED_TOPIC_FILTER_ENABLED && FEED_ALLOWED_TOPICS.length > 0) {
    if (!FEED_ALLOWED_TOPICS.includes(topicKey)) {
      const minimalItem: FeedItem = {
        event_id: row.id,
        state: row.state,
        headline: headline || null,
        t_last: row.tLast?.toISOString() ?? null,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: null,
        topic_key: topicKey,
      };
      return { item: minimalItem, eligible: false, gateReasons: ['TOPIC_FILTERED'] };
    }
  }

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
    topic_key: topicKey,
    topic_confidence: topicConfidence,
    ...enrichFeedItem(row, packet),
  };

  // ── Importance score v2 (multi vs single formula) ────────────────
  const hoursAge = row.publishedAt
    ? (Date.now() - new Date(row.publishedAt).getTime()) / (3600 * 1000)
    : null;
  const importanceScore = computeImportanceScore({
    topic_key: topicKey,
    text_len: item.total_usable_text_len ?? 0,
    hours_since_published: hoursAge,
    unique_sources_count: item.unique_sources_count ?? 1,
  });
  item.importance_score = importanceScore;

  const gate = applyPublishGate(item, packet, row, importanceScore, topicKey, topicConfidence);

  // Apply demotion multiplier (affects ranking, not eligibility)
  if (gate.eligible) {
    const demotion = computeDemotionMultiplier({
      unique_sources_count: item.unique_sources_count ?? 1,
      topic_confidence: topicConfidence,
      topic_key: topicKey,
      total_usable_text_len: item.total_usable_text_len ?? 0,
    });
    item.demotion_multiplier = demotion.multiplier;
    item.demotion_reasons = demotion.reasons;

    // v3 topic-first ranking score
    const articles = (row.eventArticles ?? []).map((ea: any) => ea.article);
    const now6h = Date.now() - 6 * 60 * 60 * 1000;
    const momentum6h = (row.eventArticles ?? []).filter(
      (ea: any) => ea.createdAt && new Date(ea.createdAt).getTime() >= now6h,
    ).length;
    const v3 = computePublicImportanceV3({
      topic_key: topicKey,
      topic_confidence: topicConfidence,
      num_sources_unique: item.unique_sources_count ?? 1,
      num_articles: articles.length,
      momentum_6h: momentum6h,
      demotion_multiplier: demotion.multiplier,
    });
    item.public_importance_v3_raw = v3.raw;
    item.public_importance_v3_final = v3.final;
    item.public_importance_v3_components = v3.components;
  }

  // Fallback overview for non-ready items that pass the gate
  if (gate.eligible && item.overview_status !== 'ready' && !item.ai_overview) {
    item.ai_overview = buildFeedFallbackOverview(
      item.headline,
      item.sources ?? [],
      item.overview_status ?? 'pending',
    );
  }

  return { item, eligible: gate.eligible, gateReasons: gate.reasons };
}

/**
 * Log gate-filtered items for observability.
 */
function logGatedItems(
  total: number,
  eligibleItems: Array<{ item: FeedItem }>,
  gatedItems: Array<{ item: FeedItem; gateReasons: string[] }>,
): void {
  if (gatedItems.length > 0) {
    logger.info({
      total,
      eligible: eligibleItems.length,
      gated: gatedItems.length,
      sample_reasons: gatedItems.slice(0, 5).map((r) => ({
        event_id: r.item.event_id,
        reasons: r.gateReasons,
        overview_status: r.item.overview_status,
        sources: r.item.unique_sources_count,
        text_len: r.item.total_usable_text_len,
      })),
    }, 'feed_publish_gate_filtered');
  }
}

/**
 * Sort feed items by public_importance_v3_final descending, with recency tiebreaker.
 */
function sortByV3(items: Array<{ item: FeedItem }>): void {
  items.sort((a, b) => {
    const aScore = a.item.public_importance_v3_final ?? 0;
    const bScore = b.item.public_importance_v3_final ?? 0;
    if (Math.abs(bScore - aScore) > 1e-9) return bScore - aScore;
    // Recency tiebreaker: more recent first
    const aTs = a.item.published_at ? new Date(a.item.published_at).getTime() : 0;
    const bTs = b.item.published_at ? new Date(b.item.published_at).getTime() : 0;
    return bTs - aTs;
  });
}

const PAGE_SIZE = 20;

export class FeedService {
  private rankingService: RankingService | null;
  private repo: FeedRepository;

  constructor(repo: FeedRepository, rankingService?: RankingService) {
    this.repo = repo;
    this.rankingService = rankingService ?? null;
  }

  private async diagnoseEmpty(publishedRows: number, gatedAll: boolean): Promise<EmptyReason> {
    if (gatedAll) return 'GATE_FILTERED_ALL';
    if (publishedRows === 0) {
      const stateCounts = await this.repo.countEventsByState();
      const total = Object.values(stateCounts).reduce((a, b) => a + b, 0);
      if (total === 0) return 'DB_EMPTY';
      if (!stateCounts['PUBLISHED'] || stateCounts['PUBLISHED'] === 0) return 'NO_PUBLISHED';
    }
    return 'NO_EVENTS';
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
      const empty_reason = await this.diagnoseEmpty(0, false);
      return { items: [], next_cursor: null, empty_reason };
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

    // v3: re-sort eligible items by public_importance_v3_final desc, recency tiebreaker
    sortByV3(eligible);

    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    // Cursor for page 2+: fall back to chronological after ranked page 1
    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastIdx = PAGE_SIZE - 1;
      const lastRow = rankedRows[scored.findIndex((s) => s.eventId === eligible[lastIdx].item.event_id)] ?? rankedRows[lastIdx];
      const ts = lastRow?.publishedAt?.toISOString() ?? lastRow?.createdAt?.toISOString() ?? new Date().toISOString();
      next_cursor = Buffer.from(`${ts}|${eligible[lastIdx].item.event_id}`).toString('base64');
    }

    if (feedItems.length === 0) {
      const empty_reason = await this.diagnoseEmpty(rows.length, gated.length > 0 && eligible.length === 0);
      return { items: [], next_cursor: null, empty_reason };
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

    const allItems = rows.map((row: any) => buildFeedItem(row));
    const eligible = allItems.filter((r) => r.eligible);
    const gated = allItems.filter((r) => !r.eligible);
    logGatedItems(allItems.length, eligible, gated);

    // v3: sort eligible items by public_importance_v3_final desc, recency tiebreaker
    sortByV3(eligible);

    const feedItems = eligible.slice(0, PAGE_SIZE).map((r) => r.item);

    let next_cursor: string | null = null;
    if (eligible.length > PAGE_SIZE) {
      const lastRow = rows.find((r: any) => r.id === eligible[PAGE_SIZE - 1].item.event_id) ?? rows[rows.length - 1];
      const ts = lastRow?.publishedAt?.toISOString() ?? lastRow?.createdAt?.toISOString() ?? new Date().toISOString();
      next_cursor = Buffer.from(`${ts}|${eligible[PAGE_SIZE - 1].item.event_id}`).toString('base64');
    }

    if (feedItems.length === 0) {
      const empty_reason = await this.diagnoseEmpty(rows.length, gated.length > 0 && eligible.length === 0);
      return { items: [], next_cursor: null, empty_reason };
    }

    return { items: feedItems, next_cursor };
  }
}
