import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ulid } from 'ulid';
import { ScrapeOrchestrator } from '../../modules/ingestion/service/scrape-orchestrator.js';
import { scrapeLock } from '../../modules/ingestion/service/scrape-lock.js';
import { withTimeout, TimeoutError } from '../../core/async/with-timeout.js';
import { metrics } from '../../core/metrics/metrics.js';
import { logger } from '../../core/logging/logger.js';

const SCRAPE_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? '60000', 10);

export function debugScrapeRoutes(orchestrator: ScrapeOrchestrator): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.post('/v1/debug/scrape/run', async (request, reply) => {
      const traceId = ulid();
      reply.header('x-trace-id', traceId);

      if (!scrapeLock.tryAcquire(traceId)) {
        metrics.incCounter('scrape.already_running_total');
        const status = scrapeLock.getStatus();
        return reply.status(409).send({
          ok: false,
          error: 'SCRAPE_ALREADY_RUNNING',
          started_at: status.started_at,
          trace_id: status.trace_id,
        });
      }

      metrics.incCounter('scrape.runs_total');
      metrics.setGauge('scrape.inflight', 1);
      const startMs = Date.now();

      try {
        const result = await withTimeout(
          orchestrator.run(),
          SCRAPE_TIMEOUT_MS,
          { stage: 'orchestrator_run' },
        );

        const durationMs = Date.now() - startMs;
        metrics.observeHistogram('scrape.run_duration_ms', durationMs);
        metrics.setGauge('scrape.inflight', 0);
        scrapeLock.release({ summary: result.summary as unknown as Record<string, unknown> });

        logger.info({ trace_id: traceId, duration_ms: durationMs, discovered: result.discovered, skipped: result.skipped }, 'scrape_debug_run_complete');

        return reply.send({
          ok: true,
          trace_id: traceId,
          duration_ms: durationMs,
          discovered: result.discovered,
          skipped: result.skipped,
          summary: result.summary,
        });
      } catch (err) {
        const durationMs = Date.now() - startMs;
        metrics.setGauge('scrape.inflight', 0);

        if (err instanceof TimeoutError) {
          metrics.incCounter('scrape.timeout_total');
          scrapeLock.release({ error: err.message });

          logger.error({ trace_id: traceId, stage: err.stage, media_key: err.mediaKey, timeout_ms: err.timeoutMs, duration_ms: durationMs }, 'scrape_timeout');

          return reply.status(504).send({
            ok: false,
            error: 'SCRAPE_TIMEOUT',
            trace_id: traceId,
            stage: err.stage,
            media_key: err.mediaKey,
            timeout_ms: err.timeoutMs,
          });
        }

        const error = err instanceof Error ? err : new Error(String(err));
        metrics.incCounter('scrape.errors_total');
        scrapeLock.release({ error: error.message });

        logger.error({ trace_id: traceId, error: error.message, stack: error.stack, duration_ms: durationMs }, 'scrape_debug_run_error');

        return reply.status(500).send({
          ok: false,
          error: 'SCRAPE_ERROR',
          trace_id: traceId,
          message: error.message,
        });
      }
    });

    app.get('/v1/debug/scrape/status', async (_request, reply) => {
      return reply.send(scrapeLock.getStatus());
    });

    done();
  };
}
