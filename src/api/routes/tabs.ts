import { FastifyInstance } from 'fastify';

const TABS = [
  { key: 'global', label: 'Global' },
  { key: 'economia', label: 'Economía' },
  { key: 'colombia', label: 'Colombia' },
];

export async function tabsRoutes(app: FastifyInstance) {
  app.get('/v1/tabs', async (_request, _reply) => {
    return { items: TABS };
  });
}
