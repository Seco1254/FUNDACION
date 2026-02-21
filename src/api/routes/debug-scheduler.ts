import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { getRuntimeNow, getRuntimeTzDebug } from '../../core/time/runtime-time.js';

export function debugSchedulerRoutes(scheduler: Scheduler, tickMs: number): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/scheduler/status', async (_request, reply) => {
      const now = getRuntimeNow();
      const tzDebug = getRuntimeTzDebug();
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
        now_local: tzDebug.localIso,
        runtime_tz: tzDebug.tz,
        runtime_tz_offset_min: tzDebug.tzOffsetMin,
        queued_jobs_count: jobs.length,
        next_5_jobs: next5,
        last_tick_at: scheduler.lastTickAt?.toISOString() ?? null,
        last_tick_executed: scheduler.lastTickExecuted,
        is_running: scheduler.running,
      });
    });

    app.post('/v1/debug/scheduler/tick', async (_request, reply) => {
      if (process.env.NODE_ENV === 'production') {
        return reply.status(403).send({ error: 'disabled_in_production' });
      }

      const before = scheduler.list().length;
      const executed = await scheduler.runDueJobs();
      const after = scheduler.list().length;

      return reply.send({
        ok: true,
        jobs_before: before,
        jobs_executed: executed,
        jobs_after: after,
        last_tick_at: scheduler.lastTickAt?.toISOString() ?? null,
      });
    });

    done();
  };
}
