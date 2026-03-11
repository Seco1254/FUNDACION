import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';

/**
 * GET /v1/debug/extractor/sample?limit=20
 *
 * Returns a sample of recent articles with extraction diagnostics:
 *  - url, title, routing decision, content_type
 *  - text_len (textContentLen), text_content_source
 *  - sample_excerpt (first 300 chars of textNorm)
 *
 * Useful for inspecting whether dom_cleaner_v1 is activating and
 * how much boilerplate it removes compared to legacy extraction.
 */
export function debugExtractorRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/extractor/sample', async (request, reply) => {
      const { limit: rawLimit } = request.query as { limit?: string };
      const limit = Math.min(parseInt(rawLimit ?? '20', 10) || 20, 100);

      const articles = await prisma.article.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          url: true,
          title: true,
          contentType: true,
          routingDecision: true,
          textContentLen: true,
          textContentSource: true,
          textNorm: true,
          usableForOverview: true,
          createdAt: true,
        },
      });

      const rows = articles.map((a) => {
        const normLen = a.textNorm?.length ?? 0;
        return {
          url: a.url,
          title: a.title,
          routing_decision: a.routingDecision ?? 'unknown',
          content_type: a.contentType ?? 'unknown',
          text_len: a.textContentLen ?? 0,
          text_content_source: a.textContentSource ?? 'none',
          usable_for_overview: a.usableForOverview,
          created_at: a.createdAt.toISOString(),
          sample_excerpt_after: a.textNorm
            ? a.textNorm.slice(0, 300).replace(/\n/g, ' ') + (normLen > 300 ? '…' : '')
            : null,
        };
      });

      // Summary stats
      const bySource: Record<string, number> = {};
      const byRouting: Record<string, number> = {};
      for (const r of rows) {
        bySource[r.text_content_source] = (bySource[r.text_content_source] ?? 0) + 1;
        byRouting[r.routing_decision] = (byRouting[r.routing_decision] ?? 0) + 1;
      }

      return reply.send({
        total: rows.length,
        summary: {
          by_text_content_source: bySource,
          by_routing_decision: byRouting,
        },
        articles: rows,
      });
    });

    done();
  };
}
