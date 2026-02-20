import { Scheduler } from './scheduler.js';

export interface PendingPublishRepo {
  findPendingPublish(): Promise<Array<{ id: string; publishAt: Date | null }>>;
}

/**
 * Rehydrate publish jobs from DB into the in-memory scheduler.
 *
 * Call on server startup so PENDING_PUBLISH events that existed before a
 * restart are not lost (the scheduler is in-memory and resets on restart).
 *
 * Safe to call multiple times — Scheduler.register() is idempotent (dedup by jobKey).
 *
 * @returns Number of jobs registered.
 */
export async function rehydratePublishJobs(
  scheduler: Scheduler,
  eventRepo: PendingPublishRepo,
): Promise<number> {
  const pending = await eventRepo.findPendingPublish();
  let count = 0;
  for (const ev of pending) {
    // If publishAt is null (edge case: event stuck without a publish time),
    // schedule for immediate execution so it isn't lost across restarts.
    const runAt = ev.publishAt ? new Date(ev.publishAt) : new Date();
    scheduler.register(`publish:${ev.id}`, runAt, { eventId: ev.id });
    count++;
  }
  return count;
}
