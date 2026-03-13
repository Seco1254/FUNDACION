import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { Cache } from '../../core/cache/cache.js';
import { PRODUCT_TOPIC_LABELS, PRODUCT_TOPIC_KEYS } from '../../contracts/product/shared.js';
import type { TopicsResponse } from '../../contracts/product/topics.js';

export function topicsRoutes(prisma: PrismaClient, cache?: Cache) {
  return async function (app: FastifyInstance) {
    app.get('/v1/topics', async (_request, reply) => {
      const cacheKey = 'topics:list';

      if (cache) {
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return cached;
      }

      // Count distinct published events per topic, excluding OTROS
      const rows = await prisma.$queryRaw<Array<{ topic_key: string; event_count: bigint }>>`
        SELECT ta.topic_key, COUNT(DISTINCT ta.event_id) AS event_count
        FROM topic_assignment ta
        JOIN event e ON e.id = ta.event_id
        WHERE e.state = 'PUBLISHED'
          AND e.canonical_event_id IS NULL
          AND ta.topic_key != 'OTROS'
        GROUP BY ta.topic_key
        ORDER BY event_count DESC
      `;

      const body: TopicsResponse = {
        items: rows
          .filter((r) => PRODUCT_TOPIC_KEYS.has(r.topic_key))
          .map((r) => ({
            key: r.topic_key as keyof typeof PRODUCT_TOPIC_LABELS,
            label: PRODUCT_TOPIC_LABELS[r.topic_key as keyof typeof PRODUCT_TOPIC_LABELS] ?? r.topic_key,
            event_count: Number(r.event_count),
          })),
      };

      if (cache) {
        cache.set(cacheKey, body, 30_000);
      }

      reply.header('cache-control', 'public, max-age=30');
      return body;
    });
  };
}
