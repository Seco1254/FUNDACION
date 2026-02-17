import { FastifyInstance } from 'fastify';
import { FeedService } from '../../modules/feed/service/feed-service.js';

export function feedRoutes(feedService: FeedService) {
  return async function (app: FastifyInstance) {
    app.get<{ Querystring: { tab?: string; cursor?: string } }>(
      '/v1/feed',
      async (request, _reply) => {
        const cursor = request.query.cursor;
        return feedService.getFeed(cursor);
      },
    );
  };
}
