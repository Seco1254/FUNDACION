import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/v1/health', async (_request, _reply) => {
    return {
      ok: true,
      time: new Date().toISOString(),
    };
  });
}
