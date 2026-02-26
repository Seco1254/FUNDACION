import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';

export function debugRoutingRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get<{ Querystring: { limit?: string } }>(
      '/v1/debug/routing/summary',
      async (request, reply) => {
        const limitStr = request.query.limit;
        const limit = limitStr ? parseInt(limitStr, 10) : 500;

        if (isNaN(limit) || limit < 1 || limit > 5000) {
          return reply.status(400).send({
            error: 'Invalid limit parameter',
            message: 'limit must be between 1 and 5000.',
          });
        }

        const articles = await prisma.article.findMany({
          select: {
            routingDecision: true,
            contentType: true,
            textContentLen: true,
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
        });

        const totalArticles = articles.length;

        // Counts by routing_decision
        const countsByRoutingDecision: Record<string, number> = {};
        for (const a of articles) {
          const rd = a.routingDecision ?? 'null';
          countsByRoutingDecision[rd] = (countsByRoutingDecision[rd] ?? 0) + 1;
        }

        // Counts by content_type
        const countsByContentType: Record<string, number> = {};
        for (const a of articles) {
          const ct = a.contentType ?? 'null';
          countsByContentType[ct] = (countsByContentType[ct] ?? 0) + 1;
        }

        // Avg text length by routing bucket
        const bucketLens: Record<string, { sum: number; count: number }> = {};
        for (const a of articles) {
          const rd = a.routingDecision ?? 'null';
          if (!bucketLens[rd]) bucketLens[rd] = { sum: 0, count: 0 };
          bucketLens[rd].sum += a.textContentLen ?? 0;
          bucketLens[rd].count++;
        }
        const avgTextLengthByBucket: Record<string, number> = {};
        for (const [bucket, { sum, count }] of Object.entries(bucketLens)) {
          avgTextLengthByBucket[bucket] = count > 0 ? Math.round(sum / count) : 0;
        }

        return reply.send({
          total_articles: totalArticles,
          counts_by_routing_decision: countsByRoutingDecision,
          counts_by_content_type: countsByContentType,
          avg_text_length_by_bucket: avgTextLengthByBucket,
        });
      },
    );

    done();
  };
}
