import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { ClaimRepository } from '../../modules/claims/repo/claim-repo.js';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';

export function eventDetailRoutes(
  eventRepo: EventRepository,
  claimRepo?: ClaimRepository,
  biasRepo?: BiasLabelRepository,
) {
  return async function (app: FastifyInstance) {
    app.get<{ Params: { eventId: string } }>(
      '/v1/events/:eventId',
      async (request, reply) => {
        const { eventId } = request.params;

        const eventWithDetails = await eventRepo.findByIdWithDetails(eventId);
        if (!eventWithDetails) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        const latestVersion = eventWithDetails.versions[0] ?? null;

        const articles = (eventWithDetails.eventArticles ?? []).map((ea: any) => ({
          article_id: ea.article.id,
          media_key: ea.article.media?.mediaKey ?? 'unknown',
          title: ea.article.title,
          snippet: ea.article.snippet,
          url: ea.article.url,
          published_at: ea.article.publishedAt?.toISOString?.() ?? null,
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
          const mediaArticleIds = items.map((a) => a.article_id);
          const allQuotes = mediaArticleIds.flatMap((aid) => quotesPerArticle.get(aid) ?? []);
          const sorted = allQuotes.sort((a, b) => (strengthOrder[b.strength] ?? 0) - (strengthOrder[a.strength] ?? 0));
          const highlights = sorted.slice(0, 3).map((q) => ({
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

        // Bias from bias_label table
        let bias: { media_level: any[]; article_level: any[] } = { media_level: [], article_level: [] };
        if (biasRepo && latestVersion) {
          try {
            const mediaLabels = await biasRepo.findMediaLevelByEvent(eventId, latestVersion.id);
            const articleLabels = await biasRepo.findArticleLevelByEvent(eventId, latestVersion.id);
            bias = {
              media_level: mediaLabels.map((l) => ({
                media_id: l.mediaId,
                label_primary: l.labelPrimary,
                label_secondary: l.labelSecondary,
                intensity: l.intensity,
                confidence: l.confidence,
                rationale: l.rationaleJson,
              })),
              article_level: articleLabels.map((l) => ({
                article_id: l.articleId,
                media_id: l.mediaId,
                label_primary: l.labelPrimary,
                label_secondary: l.labelSecondary,
                intensity: l.intensity,
                confidence: l.confidence,
                rationale: l.rationaleJson,
              })),
            };
          } catch {
            // Bias table may not exist yet
          }
        }

        // Topics + heatmap + subevents from packet_json
        const topics = packetJson.topics ?? { top_topics: [], emergent: [] };
        const topicsHeatmap = packetJson.topics_heatmap ?? [];
        const subevents = packetJson.subevents ?? [];

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
          bias,
          topics,
          topics_heatmap: topicsHeatmap,
          subevents,
          heatmap: { status: 'placeholder' },
        };
      },
    );
  };
}
