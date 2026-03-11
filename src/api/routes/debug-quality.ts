import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { QualitySnapshotService } from '../../modules/quality/service/quality-snapshot.js';

export function debugQualityRoutes(
  qualityService: QualitySnapshotService,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get<{ Querystring: { hours?: string } }>(
      '/v1/debug/quality/snapshot',
      async (request, reply) => {
        const hoursStr = request.query.hours;
        const hours = hoursStr ? parseInt(hoursStr, 10) : 24;

        if (isNaN(hours) || hours < 1 || hours > 720) {
          return reply.status(400).send({
            error: 'Invalid hours parameter',
            message: 'hours must be between 1 and 720 (30 days).',
          });
        }

        const snapshot = await qualityService.generate(hours);
        return reply.send(snapshot);
      },
    );

    done();
  };
}
