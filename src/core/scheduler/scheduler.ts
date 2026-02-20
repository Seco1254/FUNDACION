import { Clock } from '../time/clock.js';
import { logger } from '../logging/logger.js';

export interface ScheduledJob {
  jobKey: string;
  runAt: Date;
  payload: Record<string, unknown>;
}

export type JobExecutor = (job: ScheduledJob) => Promise<void>;

export class Scheduler {
  private jobs: Map<string, ScheduledJob> = new Map();
  private clock: Clock;
  private executor: JobExecutor;
  private _running = false;
  private _lastTickAt: Date | null = null;
  private _lastTickExecuted = 0;

  constructor(clock: Clock, executor: JobExecutor) {
    this.clock = clock;
    this.executor = executor;
  }

  register(jobKey: string, runAt: Date, payload: Record<string, unknown>): void {
    const existing = this.jobs.get(jobKey);
    if (existing) {
      if (existing.runAt.getTime() === runAt.getTime()) {
        return; // identical — no-op
      }
      this.jobs.set(jobKey, { jobKey, runAt, payload });
      logger.info({ jobKey, runAt: runAt.toISOString(), prevRunAt: existing.runAt.toISOString() }, 'scheduler_job_updated');
      return;
    }
    this.jobs.set(jobKey, { jobKey, runAt, payload });
    logger.info({ jobKey, runAt: runAt.toISOString() }, 'scheduler_job_registered');
  }

  cancel(jobKey: string): boolean {
    const deleted = this.jobs.delete(jobKey);
    if (deleted) {
      logger.info({ jobKey }, 'scheduler_job_cancelled');
    }
    return deleted;
  }

  list(): ScheduledJob[] {
    return Array.from(this.jobs.values());
  }

  get lastTickAt(): Date | null {
    return this._lastTickAt;
  }

  get lastTickExecuted(): number {
    return this._lastTickExecuted;
  }

  get running(): boolean {
    return this._running;
  }

  async runDueJobs(): Promise<number> {
    if (this._running) {
      logger.info('scheduler_tick_skipped_already_running');
      return 0;
    }

    this._running = true;
    const now = this.clock.now();
    this._lastTickAt = now;
    let executed = 0;
    const dueCount = Array.from(this.jobs.values()).filter((j) => j.runAt <= now).length;

    logger.info({ queued: this.jobs.size, due: dueCount, now: now.toISOString() }, 'scheduler_tick_start');

    try {
      for (const [key, job] of this.jobs.entries()) {
        if (job.runAt <= now) {
          const jobStart = Date.now();
          try {
            await this.executor(job);
            this.jobs.delete(key);
            executed++;
            logger.info({ jobKey: key, duration_ms: Date.now() - jobStart }, 'scheduler_job_executed');
          } catch (err) {
            logger.error(
              { jobKey: key, duration_ms: Date.now() - jobStart, error: err instanceof Error ? err.message : String(err) },
              'scheduler_job_failed',
            );
          }
        }
      }
    } finally {
      this._running = false;
      this._lastTickExecuted = executed;
    }

    return executed;
  }
}
