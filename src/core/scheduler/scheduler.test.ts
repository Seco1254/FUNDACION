import { describe, it, expect, vi } from 'vitest';
import { Scheduler } from './scheduler.js';
import { FakeClock } from '../time/clock.js';

describe('Scheduler', () => {
  function setup() {
    const clock = new FakeClock(new Date('2025-06-01T12:00:00Z'));
    const executor = vi.fn().mockResolvedValue(undefined);
    const scheduler = new Scheduler(clock, executor);
    return { clock, executor, scheduler };
  }

  it('registers a job', () => {
    const { scheduler } = setup();
    scheduler.register('publish:evt-1', new Date('2025-06-01T13:00:00Z'), { event_id: 'evt-1' });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].jobKey).toBe('publish:evt-1');
  });

  it('upserts runAt when same jobKey re-registered with different time', () => {
    const { scheduler } = setup();
    scheduler.register('publish:evt-1', new Date('2025-06-01T13:00:00Z'), { event_id: 'evt-1' });
    scheduler.register('publish:evt-1', new Date('2025-06-01T14:00:00Z'), { event_id: 'evt-1' });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].runAt).toEqual(new Date('2025-06-01T14:00:00Z'));
  });

  it('no-ops when same jobKey re-registered with identical time', () => {
    const { scheduler } = setup();
    scheduler.register('publish:evt-1', new Date('2025-06-01T13:00:00Z'), { event_id: 'evt-1' });
    scheduler.register('publish:evt-1', new Date('2025-06-01T13:00:00Z'), { event_id: 'evt-1' });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].runAt).toEqual(new Date('2025-06-01T13:00:00Z'));
  });

  it('schedule twice same event yields 1 job with updated runAt', () => {
    const { scheduler } = setup();
    scheduler.register('publish:evt-A', new Date('2025-06-01T13:00:00Z'), { eventId: 'A' });
    scheduler.register('publish:evt-A', new Date('2025-06-01T15:00:00Z'), { eventId: 'A' });
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].runAt).toEqual(new Date('2025-06-01T15:00:00Z'));
  });

  it('schedule different events yields 2 jobs', () => {
    const { scheduler } = setup();
    scheduler.register('publish:evt-A', new Date('2025-06-01T13:00:00Z'), { eventId: 'A' });
    scheduler.register('publish:evt-B', new Date('2025-06-01T14:00:00Z'), { eventId: 'B' });
    expect(scheduler.list()).toHaveLength(2);
  });

  it('cancels a job', () => {
    const { scheduler } = setup();
    scheduler.register('close:evt-1', new Date('2025-06-01T13:00:00Z'), {});
    expect(scheduler.cancel('close:evt-1')).toBe(true);
    expect(scheduler.list()).toHaveLength(0);
  });

  it('returns false when cancelling non-existent job', () => {
    const { scheduler } = setup();
    expect(scheduler.cancel('nonexistent')).toBe(false);
  });

  it('runDueJobs executes only jobs <= now', async () => {
    const { clock, executor, scheduler } = setup();

    scheduler.register('publish:evt-1', new Date('2025-06-01T12:30:00Z'), { event_id: 'evt-1' });
    scheduler.register('publish:evt-2', new Date('2025-06-01T14:00:00Z'), { event_id: 'evt-2' });

    // At 12:00, neither is due since 12:30 > 12:00
    let executed = await scheduler.runDueJobs();
    expect(executed).toBe(0);
    expect(executor).not.toHaveBeenCalled();

    // Advance to 12:30
    clock.setNow(new Date('2025-06-01T12:30:00Z'));
    executed = await scheduler.runDueJobs();
    expect(executed).toBe(1);
    expect(executor).toHaveBeenCalledOnce();
    expect(executor).toHaveBeenCalledWith(
      expect.objectContaining({ jobKey: 'publish:evt-1' }),
    );

    // Job should be removed after execution
    expect(scheduler.list()).toHaveLength(1);
    expect(scheduler.list()[0].jobKey).toBe('publish:evt-2');
  });

  it('runDueJobs uses FakeClock correctly', async () => {
    const { clock, executor, scheduler } = setup();

    scheduler.register(
      'refresh:evt-1:2025-06-01T15:00:00Z',
      new Date('2025-06-01T15:00:00Z'),
      {},
    );

    // Advance by 3 hours (past the job time)
    clock.advanceBy(3 * 60 * 60 * 1000);
    const executed = await scheduler.runDueJobs();
    expect(executed).toBe(1);
    expect(executor).toHaveBeenCalledOnce();
  });
});
