import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { evaluatePublishGate } from '../../core/llm/gates.js';

/**
 * Debug endpoint for feed pipeline observability.
 * Only useful in dev — exposes DB counts and gate diagnostics.
 */
export function debugFeedRoutes(prisma: PrismaClient): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/feed/stats', async (_request, reply) => {
      // Count events by state
      const stateCounts = await prisma.event.groupBy({
        by: ['state'],
        _count: { id: true },
      });

      const eventsByState: Record<string, number> = {};
      for (const row of stateCounts) {
        eventsByState[row.state] = row._count.id;
      }

      // Count total articles
      const articlesTotal = await prisma.article.count();

      // Sample PUBLISHED events with gate diagnostics
      const published = await prisma.event.findMany({
        where: { state: 'PUBLISHED' as any, canonicalEventId: null },
        orderBy: { publishedAt: 'desc' },
        take: 10,
        include: {
          versions: { orderBy: { versionIndex: 'desc' }, take: 1 },
          eventArticles: {
            include: {
              article: {
                select: {
                  id: true,
                  url: true,
                  textContentLen: true,
                  usableForOverview: true,
                  media: { select: { mediaKey: true, name: true } },
                },
              },
            },
          },
        },
      });

      const sample = published.map((evt) => {
        const version = evt.versions[0] ?? null;
        const packet = (version?.packetJson as any) ?? {};
        const articles = evt.eventArticles.map((ea) => ea.article);
        const uniqueMedia = new Set(articles.map((a) => a.media?.mediaKey ?? 'unknown'));
        const usable = articles.filter((a) => a.usableForOverview);
        const totalText = usable.reduce((sum, a) => sum + (a.textContentLen ?? 0), 0);
        const keyFactsCount = packet.key_facts_count ?? 0;

        const ai = packet.ai_overview;
        const wh = Array.isArray(ai?.what_happened) ? ai.what_happened : [];
        const ctx = Array.isArray(ai?.context) ? ai.context : [];
        const overviewStatus = !ai ? 'pending' : (wh.length > 0 || ctx.length > 0) ? 'ready' : 'unavailable';

        const hasDisclaimer = typeof ai?.why === 'string'
          && /única fuente|una fuente|una sola fuente|evidencia limitada/i.test(ai.why);

        const gate = evaluatePublishGate({
          unique_sources_count: uniqueMedia.size,
          total_usable_text_len: totalText,
          key_facts_count: keyFactsCount,
          overview_status: overviewStatus,
          has_disclaimer: hasDisclaimer,
        });

        return {
          event_id: evt.id,
          published_at: evt.publishedAt?.toISOString() ?? null,
          headline: version?.headline ?? null,
          unique_sources: uniqueMedia.size,
          articles: articles.length,
          usable_articles: usable.length,
          total_text: totalText,
          key_facts: keyFactsCount,
          overview_status: overviewStatus,
          overview_mode: packet.overview_mode ?? null,
          has_disclaimer: hasDisclaimer,
          gate_eligible: gate.eligible,
          gate_name: gate.gate_name,
          gate_reasons: gate.reasons,
        };
      });

      const eligible = sample.filter((s) => s.gate_eligible).length;

      return reply.send({
        articles_total: articlesTotal,
        events_by_state: eventsByState,
        published_count: published.length,
        published_eligible: eligible,
        published_gated: published.length - eligible,
        sample,
      });
    });

    done();
  };
}
