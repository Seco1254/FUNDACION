import { FastifyInstance } from 'fastify';
import { metrics } from '../../core/metrics/metrics.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/v1/metrics', async (request, reply) => {
    const accept = request.headers.accept ?? '';

    if (accept.includes('text/plain') || accept.includes('text/prometheus')) {
      reply.header('content-type', 'text/plain; charset=utf-8');
      return metrics.toPrometheus();
    }

    reply.header('content-type', 'application/json');
    return metrics.toJSON();
  });
}
