import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { buildFeedItem } from '../../modules/feed/service/feed-service.js';
import { Cache } from '../../core/cache/cache.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MIN_QUERY_LEN = 2;

export function searchRoutes(eventRepo: EventRepository, cache?: Cache) {
  return async function (app: FastifyInstance) {
    app.get<{ Querystring: { q?: string; limit?: string } }>(
      '/v1/search',
      async (request, reply) => {
        const q = (request.query.q ?? '').trim();

        if (q.length < MIN_QUERY_LEN) {
          return reply.status(400).send({
            error: 'Invalid query',
            message: `Query parameter "q" must be at least ${MIN_QUERY_LEN} characters.`,
          });
        }

        const limit = Math.min(
          Math.max(1, parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
          MAX_LIMIT,
        );

        const cacheKey = `search:${q.toLowerCase()}:${limit}`;

        if (cache) {
          const cached = cache.get(cacheKey);
          if (cached !== undefined) return cached;
        }

        const rows = await eventRepo.searchPublished(q, limit);

        const results = rows
          .map((row: any) => buildFeedItem(row))
          .filter((r) => r.eligible)
          .map((r) => r.item);

        const body = { items: results, query: q };

        if (cache) {
          cache.set(cacheKey, body, 15_000); // 15s TTL for search
        }

        reply.header('cache-control', 'public, max-age=15');
        return body;
      },
    );
  };
}
