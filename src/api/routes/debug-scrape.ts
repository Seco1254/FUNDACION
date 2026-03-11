import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ulid } from 'ulid';
import { ScrapeOrchestrator } from '../../modules/ingestion/service/scrape-orchestrator.js';
import { scrapeLock } from '../../modules/ingestion/service/scrape-lock.js';
import { withTimeout, TimeoutError } from '../../core/async/with-timeout.js';
import { metrics } from '../../core/metrics/metrics.js';
import { logger } from '../../core/logging/logger.js';

const SCRAPE_TIMEOUT_MS = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? '60000', 10);
const MAX_JOB_HISTORY = 20;

// ── Job tracker ────────────────────────────────────────────────────
export type ScrapeJobState = 'queued' | 'running' | 'done' | 'failed';

export interface ScrapeJob {
  job_id: string;
  trace_id: string;
  state: ScrapeJobState;
  accepted_at: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  discovered: number | null;
  skipped: number | null;
  summary: Record<string, unknown> | null;
  media_results: unknown[] | null;
  error: string | null;
  error_detail: Record<string, unknown> | null;
}

/** In-memory ring buffer of recent scrape jobs. */
export class ScrapeJobTracker {
  private _jobs = new Map<string, ScrapeJob>();
  private _order: string[] = [];

  create(jobId: string, traceId: string): ScrapeJob {
    const job: ScrapeJob = {
      job_id: jobId,
      trace_id: traceId,
      state: 'queued',
      accepted_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      duration_ms: null,
      discovered: null,
      skipped: null,
      summary: null,
      media_results: null,
      error: null,
      error_detail: null,
    };
    this._jobs.set(jobId, job);
    this._order.push(jobId);
    this._evict();
    return job;
  }

  markRunning(jobId: string): void {
    const job = this._jobs.get(jobId);
    if (job) {
      job.state = 'running';
      job.started_at = new Date().toISOString();
    }
  }

  markDone(jobId: string, result: {
    duration_ms: number;
    discovered: number;
    skipped: number;
    summary: Record<string, unknown>;
    media_results: unknown[];
  }): void {
    const job = this._jobs.get(jobId);
    if (job) {
      job.state = 'done';
      job.finished_at = new Date().toISOString();
      job.duration_ms = result.duration_ms;
      job.discovered = result.discovered;
      job.skipped = result.skipped;
      job.summary = result.summary;
      job.media_results = result.media_results;
    }
  }

  markFailed(jobId: string, error: string, detail?: Record<string, unknown>): void {
    const job = this._jobs.get(jobId);
    if (job) {
      job.state = 'failed';
      job.finished_at = new Date().toISOString();
      if (job.started_at) {
        job.duration_ms = Date.now() - new Date(job.started_at).getTime();
      }
      job.error = error;
      job.error_detail = detail ?? null;
    }
  }

  get(jobId: string): ScrapeJob | undefined {
    return this._jobs.get(jobId);
  }

  list(): ScrapeJob[] {
    return this._order.map((id) => this._jobs.get(id)!).filter(Boolean);
  }

  private _evict(): void {
    while (this._order.length > MAX_JOB_HISTORY) {
      const old = this._order.shift()!;
      this._jobs.delete(old);
    }
  }
}

/** Singleton tracker — exported for testing. */
export const scrapeJobTracker = new ScrapeJobTracker();

// ── Routes ─────────────────────────────────────────────────────────

export function debugScrapeRoutes(
  orchestrator: ScrapeOrchestrator,
  tracker: ScrapeJobTracker = scrapeJobTracker,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    /**
     * POST /v1/debug/scrape/run
     *
     * Non-blocking: enqueues a scrape job, responds 202 immediately,
     * and runs the scrape in the background.
     */
    app.post('/v1/debug/scrape/run', async (request, reply) => {
      const traceId = ulid();
      const jobId = ulid();
      reply.header('x-trace-id', traceId);

      logger.info({ trace_id: traceId, job_id: jobId }, 'debug_scrape_run_start');

      if (!scrapeLock.tryAcquire(traceId)) {
        metrics.incCounter('scrape.already_running_total');
        const status = scrapeLock.getStatus();
        logger.info({ trace_id: traceId }, 'debug_scrape_run_rejected_already_running');
        return reply.status(409).send({
          ok: false,
          error: 'SCRAPE_ALREADY_RUNNING',
          started_at: status.started_at,
          trace_id: status.trace_id,
        });
      }

      // Create tracked job and respond immediately
      const job = tracker.create(jobId, traceId);
      metrics.incCounter('scrape.runs_total');

      logger.info({ trace_id: traceId, job_id: jobId }, 'debug_scrape_run_accepted');

      // Fire-and-forget: run scrape in background
      setImmediate(() => {
        runScrapeJob(orchestrator, tracker, job, traceId).catch((err) => {
          // Safety net — should never reach here since runScrapeJob has its own catch
          logger.error(
            { trace_id: traceId, job_id: jobId, error: err instanceof Error ? err.message : String(err) },
            'debug_scrape_unhandled_error',
          );
        });
      });

      return reply.status(202).send({
        ok: true,
        job_id: jobId,
        trace_id: traceId,
        accepted_at: job.accepted_at,
        status_url: `/v1/debug/scrape/status?job_id=${jobId}`,
      });
    });

    /**
     * GET /v1/debug/scrape/status
     *
     * Without ?job_id: returns scrape lock status + recent jobs list.
     * With ?job_id=<id>: returns that specific job's state.
     */
    app.get('/v1/debug/scrape/status', async (request, reply) => {
      const { job_id } = request.query as { job_id?: string };

      if (job_id) {
        const job = tracker.get(job_id);
        if (!job) {
          return reply.status(404).send({ ok: false, error: 'JOB_NOT_FOUND', job_id });
        }
        return reply.send(job);
      }

      // Default: lock status + recent jobs
      return reply.send({
        ...scrapeLock.getStatus(),
        recent_jobs: tracker.list(),
      });
    });

    done();
  };
}

// ── Background scrape runner ───────────────────────────────────────

async function runScrapeJob(
  orchestrator: ScrapeOrchestrator,
  tracker: ScrapeJobTracker,
  job: ScrapeJob,
  traceId: string,
): Promise<void> {
  const jobId = job.job_id;
  tracker.markRunning(jobId);
  metrics.setGauge('scrape.inflight', 1);
  const startMs = Date.now();

  try {
    const result = await withTimeout(
      orchestrator.run((progress) => {
        scrapeLock.setInflight(progress.media_key, progress.stage, progress.url);
      }),
      SCRAPE_TIMEOUT_MS,
      { stage: 'orchestrator_run' },
    );

    const durationMs = Date.now() - startMs;
    metrics.observeHistogram('scrape.run_duration_ms', durationMs);
    metrics.setGauge('scrape.inflight', 0);
    scrapeLock.release({ summary: result.summary as unknown as Record<string, unknown> });

    tracker.markDone(jobId, {
      duration_ms: durationMs,
      discovered: result.discovered,
      skipped: result.skipped,
      summary: result.summary as unknown as Record<string, unknown>,
      media_results: result.media_results ?? [],
    });

    logger.info(
      { trace_id: traceId, job_id: jobId, duration_ms: durationMs, discovered: result.discovered, skipped: result.skipped },
      'debug_scrape_run_done',
    );
  } catch (err) {
    const durationMs = Date.now() - startMs;
    metrics.setGauge('scrape.inflight', 0);

    if (err instanceof TimeoutError) {
      metrics.incCounter('scrape.timeout_total');
      const inflightStatus = scrapeLock.getStatus();
      scrapeLock.release({ error: err.message });

      tracker.markFailed(jobId, 'SCRAPE_TIMEOUT', {
        stage: err.stage,
        media_key: err.mediaKey ?? inflightStatus.inflight_media_key,
        inflight_stage: inflightStatus.inflight_stage,
        inflight_url: inflightStatus.inflight_url,
        timeout_ms: err.timeoutMs,
        duration_ms: durationMs,
      });

      logger.error(
        {
          trace_id: traceId,
          job_id: jobId,
          stage: err.stage,
          media_key: err.mediaKey,
          inflight_media_key: inflightStatus.inflight_media_key,
          inflight_stage: inflightStatus.inflight_stage,
          inflight_url: inflightStatus.inflight_url,
          timeout_ms: err.timeoutMs,
          duration_ms: durationMs,
        },
        'debug_scrape_run_failed',
      );
      return;
    }

    const error = err instanceof Error ? err : new Error(String(err));
    metrics.incCounter('scrape.errors_total');
    scrapeLock.release({ error: error.message });

    tracker.markFailed(jobId, 'SCRAPE_ERROR', {
      message: error.message,
      duration_ms: durationMs,
    });

    logger.error(
      { trace_id: traceId, job_id: jobId, error: error.message, stack: error.stack, duration_ms: durationMs },
      'debug_scrape_run_failed',
    );
  }
}
