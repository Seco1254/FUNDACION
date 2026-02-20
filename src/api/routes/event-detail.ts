import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { ClaimRepository } from '../../modules/claims/repo/claim-repo.js';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';
import { Cache } from '../../core/cache/cache.js';
import { SingleFlight } from '../../core/cache/singleflight.js';
import { handleEtag } from '../../core/http/etag.js';
import { computeEvidenceLevel, buildWhyNoOverview } from '../../modules/feed/service/evidence-level.js';

/**
 * Bias safeguard: degrade display-level when confidence or evidence is insufficient.
 */
export interface BiasSafeguardConfig {
  minConfidence: number;       // below this → downgrade to "INCONCLUSO"
  minEvidenceRefs: number;     // fewer evidence_refs → downgrade
}

const DEFAULT_SAFEGUARD: BiasSafeguardConfig = {
  minConfidence: parseFloat(process.env.BIAS_MIN_CONFIDENCE ?? '0.4'),
  minEvidenceRefs: parseInt(process.env.BIAS_MIN_EVIDENCE_REFS ?? '1', 10),
};

export function applyBiasSafeguard(
  label: any,
  config: BiasSafeguardConfig,
): any {
  const confidence = label.confidence ?? 0;
  const evidenceCount = label.rationale?.evidence_refs?.length ?? 0;

  if (confidence < config.minConfidence || evidenceCount < config.minEvidenceRefs) {
    return {
      ...label,
      label_primary: 'INCONCLUSO',
      label_secondary: null,
      degraded: true,
      degraded_reason:
        confidence < config.minConfidence
          ? 'low_confidence'
          : 'insufficient_evidence',
    };
  }

  return label;
}

export function eventDetailRoutes(
  eventRepo: EventRepository,
  claimRepo?: ClaimRepository,
  biasRepo?: BiasLabelRepository,
  cache?: Cache,
  singleFlight?: SingleFlight,
  safeguardConfig?: BiasSafeguardConfig,
) {
  const safeguard = safeguardConfig ?? DEFAULT_SAFEGUARD;

  return async function (app: FastifyInstance) {
    app.get<{ Params: { eventId: string } }>(
      '/v1/events/:eventId',
      async (request, reply) => {
        const { eventId } = request.params;
        const cacheKey = `event:${eventId}`;

        // Try cache
        if (cache) {
          const cached = cache.get(cacheKey);
          if (cached !== undefined) {
            const { notModified } = handleEtag(request, reply, cached);
            reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=30');
            reply.header('vary', 'Accept, Accept-Encoding');
            if (notModified) return reply.status(304).send();
            return cached;
          }
        }

        const fetchFn = async () => {
          const eventWithDetails = await eventRepo.findByIdWithDetails(eventId);
          if (!eventWithDetails) return null;

          const latestVersion = eventWithDetails.versions[0] ?? null;

          const articles = (eventWithDetails.eventArticles ?? []).map((ea: any) => ({
            article_id: ea.article.id,
            media_key: ea.article.media?.mediaKey ?? 'unknown',
            title: ea.article.title,
            snippet: ea.article.snippet,
            url: ea.article.url,
            published_at: ea.article.publishedAt?.toISOString?.() ?? null,
            text_content_len: ea.article.textContentLen ?? 0,
            text_content_source: ea.article.textContentSource ?? 'none',
            extraction_fail_reason: ea.article.extractionFailReason ?? null,
            paywall_detected: ea.article.paywallDetected ?? false,
            usable_for_overview: ea.article.usableForOverview ?? false,
          }));

          const mediaMap = new Map<string, any[]>();
          for (const a of articles) {
            const list = mediaMap.get(a.media_key) ?? [];
            list.push(a);
            mediaMap.set(a.media_key, list);
          }

          // Fetch quotes for highlights per media tab
          let quotesPerArticle = new Map<string, any[]>();
          if (claimRepo && latestVersion) {
            try {
              const claims = await claimRepo.findClaimsWithQuotesByVersion(eventId, latestVersion.id);
              for (const claim of claims) {
                for (const quote of (claim as any).quotes ?? []) {
                  const list = quotesPerArticle.get(quote.articleId) ?? [];
                  list.push({
                    quote_id: quote.id,
                    quote_text: quote.quoteText,
                    strength: quote.strength,
                    role: quote.role,
                    claim_id: claim.id,
                    claim_status: (claim as any).status,
                  });
                  quotesPerArticle.set(quote.articleId, list);
                }
              }
            } catch {
              // Claims table may not exist yet; gracefully degrade
            }
          }

          // Build media tabs with highlights (top 3 quotes by strength)
          const strengthOrder: Record<string, number> = { STRONG: 3, MEDIUM: 2, WEAK: 1 };
          const mediaTabs = Array.from(mediaMap.entries()).map(([key, items]) => {
            const mediaArticleIds = items.map((a: any) => a.article_id);
            const allQuotes = mediaArticleIds.flatMap((aid: string) => quotesPerArticle.get(aid) ?? []);
            const sorted = allQuotes.sort((a: any, b: any) => (strengthOrder[b.strength] ?? 0) - (strengthOrder[a.strength] ?? 0));
            const highlights = sorted.slice(0, 3).map((q: any) => ({
              quote_id: q.quote_id,
              quote_text: q.quote_text,
              strength: q.strength,
              claim_id: q.claim_id,
            }));

            return {
              media_key: key,
              articles: items,
              highlights,
            };
          });

          // Overview from packet_json if available
          const packetJson = (latestVersion?.packetJson as any) ?? {};
          const overview = packetJson.overview ?? { status: 'NOT_READY' };

          // Derive overview_status for client-side state handling
          const aiOv = packetJson.ai_overview;
          let overviewStatus: 'ready' | 'unavailable' | 'pending' = 'pending';
          if (aiOv) {
            const wh = Array.isArray(aiOv.what_happened) ? aiOv.what_happened : [];
            const ctx = Array.isArray(aiOv.context) ? aiOv.context : [];
            overviewStatus = (wh.length > 0 || ctx.length > 0) ? 'ready' : 'unavailable';
          }

          // Bias from bias_label table with safeguards
          let bias: { media_level: any[]; article_level: any[] } = { media_level: [], article_level: [] };
          if (biasRepo && latestVersion) {
            try {
              const mediaLabels = await biasRepo.findMediaLevelByEvent(eventId, latestVersion.id);
              const articleLabels = await biasRepo.findArticleLevelByEvent(eventId, latestVersion.id);
              bias = {
                media_level: mediaLabels.map((l) =>
                  applyBiasSafeguard({
                    media_id: l.mediaId,
                    label_primary: l.labelPrimary,
                    label_secondary: l.labelSecondary,
                    intensity: l.intensity,
                    confidence: l.confidence,
                    rationale: l.rationaleJson,
                  }, safeguard),
                ),
                article_level: articleLabels.map((l) =>
                  applyBiasSafeguard({
                    article_id: l.articleId,
                    media_id: l.mediaId,
                    label_primary: l.labelPrimary,
                    label_secondary: l.labelSecondary,
                    intensity: l.intensity,
                    confidence: l.confidence,
                    rationale: l.rationaleJson,
                  }, safeguard),
                ),
              };
            } catch {
              // Bias table may not exist yet
            }
          }

          // Topics + heatmap + subevents from packet_json
          const topics = packetJson.topics ?? { top_topics: [], emergent: [] };
          const topicsHeatmap = packetJson.topics_heatmap ?? [];
          const subevents = packetJson.subevents ?? [];

          // Event-level evidence diagnostics
          const uniqueMediaKeys = new Set(articles.map((a: any) => a.media_key));
          const usableArticles = articles.filter((a: any) => a.usable_for_overview);
          const totalUsableTextLen = usableArticles.reduce(
            (sum: number, a: any) => sum + (a.text_content_len ?? 0), 0,
          );
          const evidenceLevel = computeEvidenceLevel(uniqueMediaKeys.size, totalUsableTextLen);
          const failReasons = articles
            .map((a: any) => a.extraction_fail_reason)
            .filter(Boolean) as string[];
          const whyNoOverview = buildWhyNoOverview({
            overviewStatus,
            uniqueSourcesCount: uniqueMediaKeys.size,
            usableArticlesCount: usableArticles.length,
            totalUsableTextLen,
            articleFailReasons: failReasons,
          });

          return {
            event: {
              id: eventWithDetails.id,
              state: eventWithDetails.state,
              t0: eventWithDetails.t0?.toISOString() ?? null,
              t_last: eventWithDetails.tLast?.toISOString() ?? null,
              publish_at: eventWithDetails.publishAt?.toISOString() ?? null,
              published_at: eventWithDetails.publishedAt?.toISOString() ?? null,
              closed_at: eventWithDetails.closedAt?.toISOString() ?? null,
              canonical_event_id: eventWithDetails.canonicalEventId ?? null,
            },
            latest_version: latestVersion
              ? {
                  version_index: latestVersion.versionIndex,
                  gate_status: latestVersion.gateStatus,
                  headline: latestVersion.headline ?? null,
                  packet_json: latestVersion.packetJson ?? {},
                  diff_json: latestVersion.diffJson ?? {},
                }
              : null,
            media_tabs: mediaTabs,
            overview,
            overview_status: overviewStatus,
            overview_mode: packetJson.overview_mode ?? null,
            article_count: articles.length,
            unique_sources_count: uniqueMediaKeys.size,
            usable_articles_count: usableArticles.length,
            total_usable_text_len: totalUsableTextLen,
            evidence_level: evidenceLevel,
            why_no_overview: whyNoOverview,
            bias,
            topics,
            topics_heatmap: topicsHeatmap,
            subevents,
            heatmap: { status: 'placeholder' },
          };
        };

        const body = singleFlight
          ? await singleFlight.do(cacheKey, fetchFn)
          : await fetchFn();

        if (body === null) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        if (cache) {
          cache.set(cacheKey, body, 60_000); // 60s TTL
        }

        const { notModified } = handleEtag(request, reply, body);
        reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=30');
        reply.header('vary', 'Accept, Accept-Encoding');
        if (notModified) return reply.status(304).send();

        return body;
      },
    );
  };
}
