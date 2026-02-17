import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ScrapeOrchestrator } from '../../modules/ingestion/service/scrape-orchestrator.js';

export function debugScrapeRoutes(orchestrator: ScrapeOrchestrator): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.post('/v1/debug/scrape/run', async (_request, reply) => {
      const result = await orchestrator.run();
      return reply.send({
        ok: true,
        discovered: result.discovered,
        skipped: result.skipped,
      });
    });

    done();
  };
}
