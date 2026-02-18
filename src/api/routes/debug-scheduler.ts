import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { Scheduler } from '../../core/scheduler/scheduler.js';

export function debugSchedulerRoutes(scheduler: Scheduler, tickMs: number): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/scheduler/status', async (_request, reply) => {
      const now = new Date();
      const jobs = scheduler.list();

      // Sort by runAt ascending, take first 5
      const sorted = [...jobs].sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
      const next5 = sorted.slice(0, 5).map((j) => ({
        jobKey: j.jobKey,
        runAt: j.runAt.toISOString(),
        due: j.runAt <= now,
        payload: j.payload,
      }));

      return reply.send({
        tick_ms: tickMs,
        now: now.toISOString(),
        queued_jobs_count: jobs.length,
        next_5_jobs: next5,
        last_tick_at: scheduler.lastTickAt?.toISOString() ?? null,
        last_tick_executed: scheduler.lastTickExecuted,
        is_running: scheduler.running,
      });
    });

    done();
  };
}
