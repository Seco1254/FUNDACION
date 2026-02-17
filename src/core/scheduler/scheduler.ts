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

  constructor(clock: Clock, executor: JobExecutor) {
    this.clock = clock;
    this.executor = executor;
  }

  register(jobKey: string, runAt: Date, payload: Record<string, unknown>): void {
    if (this.jobs.has(jobKey)) {
      logger.info({ jobKey }, 'scheduler_job_deduplicated');
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

  async runDueJobs(): Promise<number> {
    const now = this.clock.now();
    let executed = 0;

    for (const [key, job] of this.jobs.entries()) {
      if (job.runAt <= now) {
        try {
          await this.executor(job);
          this.jobs.delete(key);
          executed++;
          logger.info({ jobKey: key }, 'scheduler_job_executed');
        } catch (err) {
          logger.error(
            { jobKey: key, error: err instanceof Error ? err.message : String(err) },
            'scheduler_job_failed',
          );
        }
      }
    }

    return executed;
  }
}
