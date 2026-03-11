import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { LifecycleManager } from '../../modules/lifecycle/service/lifecycle-manager.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { logger } from '../../core/logging/logger.js';

export function debugLifecycleRoutes(
  lifecycleManager: LifecycleManager,
  eventRepo: EventRepository,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.post('/v1/debug/lifecycle/tick', async (_request, reply) => {
      const pending = await eventRepo.findPendingPublish();
      const now = new Date();

      let published = 0;
      let skipNotDue = 0;
      let skipOther = 0;

      for (const evt of pending) {
        if (evt.publishAt && evt.publishAt > now) {
          skipNotDue++;
          continue;
        }
        try {
          await lifecycleManager.executePublish(evt.id);
          published++;
        } catch (err) {
          skipOther++;
          logger.error({
            event_id: evt.id,
            error: err instanceof Error ? err.message : String(err),
          }, 'debug_lifecycle_tick_publish_error');
        }
      }

      // Re-read state after publishing
      const stateCounts = await eventRepo.countByState();

      return reply.send({
        now: now.toISOString(),
        pending_found: pending.length,
        published,
        skip_not_due: skipNotDue,
        skip_other: skipOther,
        events_by_state: stateCounts,
      });
    });

    done();
  };
}
