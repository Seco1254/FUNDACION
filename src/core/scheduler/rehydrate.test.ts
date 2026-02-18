import { describe, it, expect, vi } from 'vitest';
import { rehydratePublishJobs } from './rehydrate.js';
import { Scheduler } from './scheduler.js';
import { FakeClock } from '../time/clock.js';

function makeScheduler() {
  const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
  const executor = vi.fn().mockResolvedValue(undefined);
  return new Scheduler(clock, executor);
}

describe('rehydratePublishJobs', () => {
  it('registers publish jobs for all PENDING_PUBLISH events', async () => {
    const scheduler = makeScheduler();
    const repo = {
      findPendingPublish: vi.fn().mockResolvedValue([
        { id: 'evt-1', publishAt: new Date('2026-01-01T12:05:00Z') },
        { id: 'evt-2', publishAt: new Date('2026-01-01T12:10:00Z') },
      ]),
    };

    const count = await rehydratePublishJobs(scheduler, repo);

    expect(count).toBe(2);
    const jobs = scheduler.list();
    expect(jobs).toHaveLength(2);
    expect(jobs.map((j) => j.jobKey)).toContain('publish:evt-1');
    expect(jobs.map((j) => j.jobKey)).toContain('publish:evt-2');
  });

  it('skips events with null publishAt', async () => {
    const scheduler = makeScheduler();
    const repo = {
      findPendingPublish: vi.fn().mockResolvedValue([
        { id: 'evt-null', publishAt: null },
        { id: 'evt-ok', publishAt: new Date('2026-01-01T12:05:00Z') },
      ]),
    };

    const count = await rehydratePublishJobs(scheduler, repo);

    expect(count).toBe(1);
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].jobKey).toBe('publish:evt-ok');
  });

  it('returns 0 and registers nothing when no pending events', async () => {
    const scheduler = makeScheduler();
    const repo = { findPendingPublish: vi.fn().mockResolvedValue([]) };

    const count = await rehydratePublishJobs(scheduler, repo);

    expect(count).toBe(0);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('is idempotent — duplicate calls do not double-register (dedup by jobKey)', async () => {
    const scheduler = makeScheduler();
    const repo = {
      findPendingPublish: vi.fn().mockResolvedValue([
        { id: 'evt-1', publishAt: new Date('2026-01-01T12:05:00Z') },
      ]),
    };

    await rehydratePublishJobs(scheduler, repo);
    await rehydratePublishJobs(scheduler, repo); // second call

    expect(scheduler.list()).toHaveLength(1); // Scheduler.register deduplicates
  });

  it('jobs are executed when clock advances past publishAt', async () => {
    const clock = new FakeClock(new Date('2026-01-01T12:00:00Z'));
    const executor = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler(clock, executor);

    const repo = {
      findPendingPublish: vi.fn().mockResolvedValue([
        { id: 'evt-1', publishAt: new Date('2026-01-01T12:05:00Z') },
      ]),
    };

    await rehydratePublishJobs(scheduler, repo);

    // Not yet due
    let executed = await scheduler.runDueJobs();
    expect(executed).toBe(0);
    expect(executor).not.toHaveBeenCalled();

    // Advance past publishAt
    clock.setNow(new Date('2026-01-01T12:06:00Z'));
    executed = await scheduler.runDueJobs();
    expect(executed).toBe(1);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ jobKey: 'publish:evt-1', payload: { eventId: 'evt-1' } }),
    );
  });
});
