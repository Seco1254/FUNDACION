import { FastifyInstance } from 'fastify';

const TABS = [
  { key: 'global', label: 'Global' },
  { key: 'economia', label: 'Economía' },
  { key: 'colombia', label: 'Colombia' },
];

/**
 * @deprecated Use /v1/topics instead. This endpoint will be removed in a future release.
 */
export async function tabsRoutes(app: FastifyInstance) {
  app.get('/v1/tabs', async (_request, reply) => {
    reply.header('Deprecation', 'true');
    reply.header('Link', '</v1/topics>; rel="successor-version"');
    return { items: TABS };
  });
}
