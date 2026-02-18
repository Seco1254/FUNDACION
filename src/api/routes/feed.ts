import { FastifyInstance } from 'fastify';
import { FeedService } from '../../modules/feed/service/feed-service.js';
import { Cache } from '../../core/cache/cache.js';
import { SingleFlight } from '../../core/cache/singleflight.js';
import { handleEtag } from '../../core/http/etag.js';

/**
 * Validates a base64-encoded cursor string.
 * Valid format: base64 of "ISO8601|ulid-like-string"
 */
function isValidCursor(cursorStr: string): boolean {
  try {
    const decoded = Buffer.from(cursorStr, 'base64').toString('utf-8');
    const pipeIdx = decoded.indexOf('|');
    if (pipeIdx < 1) return false;
    const datePart = decoded.slice(0, pipeIdx);
    const idPart = decoded.slice(pipeIdx + 1);
    if (!idPart || idPart.length === 0) return false;
    const d = new Date(datePart);
    if (isNaN(d.getTime())) return false;
    return true;
  } catch {
    return false;
  }
}

export function feedRoutes(feedService: FeedService, cache?: Cache, singleFlight?: SingleFlight) {
  return async function (app: FastifyInstance) {
    app.get<{ Querystring: { tab?: string; cursor?: string } }>(
      '/v1/feed',
      async (request, reply) => {
        const cursor = request.query.cursor;

        // Cursor validation
        if (cursor !== undefined && cursor !== '') {
          if (!isValidCursor(cursor)) {
            return reply.status(400).send({
              error: 'Invalid cursor',
              message: 'The cursor parameter is malformed. Use the next_cursor value from a previous response.',
            });
          }
        }

        const cacheKey = `feed:${request.query.tab ?? 'global'}:${cursor ?? ''}`;

        // Try cache
        if (cache) {
          const cached = cache.get(cacheKey);
          if (cached !== undefined) {
            const { notModified } = handleEtag(request, reply, cached);
            reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=10');
            reply.header('vary', 'Accept, Accept-Encoding');
            if (notModified) return reply.status(304).send();
            return cached;
          }
        }

        // SingleFlight dedup
        const fetchFn = () => feedService.getFeed(cursor);
        const body = singleFlight
          ? await singleFlight.do(cacheKey, fetchFn)
          : await fetchFn();

        if (cache) {
          cache.set(cacheKey, body, 30_000); // 30s TTL
        }

        const { notModified } = handleEtag(request, reply, body);
        reply.header('cache-control', 'public, max-age=30, stale-while-revalidate=10');
        reply.header('vary', 'Accept, Accept-Encoding');
        if (notModified) return reply.status(304).send();

        return body;
      },
    );
  };
}
