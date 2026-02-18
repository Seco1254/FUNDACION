import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LifecycleManager, PUBLISH_DELAY_MS } from './lifecycle-manager.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { FakeClock } from '../../../core/time/clock.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { ulid } from 'ulid';

function makeEventCreatedEnvelope(eventId: string, seedArticleId: string): EventEnvelope {
  return {
    event_name: 'EventCreated',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { event_id: eventId, seed_article_id: seedArticleId },
  };
}

function makeArticleLinkedEnvelope(articleId: string, eventId: string, linkAction: string): EventEnvelope {
  return {
    event_name: 'ArticleLinkedToEvent',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { article_id: articleId, event_id: eventId, link_action: linkAction },
  };
}

describe('LifecycleManager', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let eventRepo: any;
  let auditWriter: any;
  let clock: FakeClock;
  let scheduler: Scheduler;

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
    clock = new FakeClock(new Date('2025-06-15T12:00:00.000Z'));
    scheduler = new Scheduler(clock, vi.fn());
    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
    eventRepo = {
      findById: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findStaleEvents: vi.fn().mockResolvedValue([]),
      findActiveEvents: vi.fn().mockResolvedValue([]),
    };
  });

  describe('handleEventCreated', () => {
    it('sets PENDING_PUBLISH and schedules publish at +5m', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.handleEventCreated()(makeEventCreatedEnvelope('ev-1', 'art-1'));

      expect(eventRepo.update).toHaveBeenCalledWith('ev-1', expect.objectContaining({
        state: 'PENDING_PUBLISH',
      }));

      const publishAt = eventRepo.update.mock.calls[0][1].publishAt as Date;
      expect(publishAt.getTime() - clock.now().getTime()).toBe(PUBLISH_DELAY_MS);

      const jobs = scheduler.list();
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobKey).toBe('publish:ev-1');

      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('EventPublishScheduled');
    });
  });

  describe('handleArticleLinked', () => {
    it('updates tLast for LINKED_EXISTING', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.handleArticleLinked()(makeArticleLinkedEnvelope('art-2', 'ev-2', 'LINKED_EXISTING'));

      expect(eventRepo.update).toHaveBeenCalledWith('ev-2', { tLast: clock.now() });
    });

    it('does not update tLast for TRIGGER_CREATE', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.handleArticleLinked()(makeArticleLinkedEnvelope('art-3', 'ev-3', 'TRIGGER_CREATE'));

      expect(eventRepo.update).not.toHaveBeenCalled();
    });

    it('emits EventUpdateTriggered with NEW_ARTICLE', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.handleArticleLinked()(makeArticleLinkedEnvelope('art-4', 'ev-4', 'LINKED_EXISTING'));

      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('EventUpdateTriggered');
      expect(published[0].payload).toHaveProperty('trigger', 'NEW_ARTICLE');
    });
  });

  describe('executePublish', () => {
    it('publishes event when now >= publishAt', async () => {
      const publishAt = new Date(clock.now().getTime() - 1000); // in the past
      eventRepo.findById.mockResolvedValue({
        id: 'ev-5',
        state: 'PENDING_PUBLISH',
        publishAt,
        publishedAt: null,
      });

      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.executePublish('ev-5');

      expect(eventRepo.update).toHaveBeenCalledWith('ev-5', expect.objectContaining({
        state: 'PUBLISHED',
      }));

      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('EventPublished');
    });

    it('does not publish when now < publishAt', async () => {
      const publishAt = new Date(clock.now().getTime() + 60000); // in the future
      eventRepo.findById.mockResolvedValue({
        id: 'ev-6',
        state: 'PENDING_PUBLISH',
        publishAt,
        publishedAt: null,
      });

      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.executePublish('ev-6');

      expect(eventRepo.update).not.toHaveBeenCalled();
      expect(published).toHaveLength(0);
    });

    it('does not publish CLOSED events', async () => {
      eventRepo.findById.mockResolvedValue({
        id: 'ev-7',
        state: 'CLOSED',
        publishAt: new Date(clock.now().getTime() - 1000),
        publishedAt: null,
      });

      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.executePublish('ev-7');

      expect(eventRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('runCloseCheck', () => {
    it('closes events with tLast > 7 days ago', async () => {
      eventRepo.findStaleEvents.mockResolvedValue([
        { id: 'ev-8', state: 'PUBLISHED', tLast: new Date('2025-06-01T00:00:00.000Z') },
      ]);

      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      const closed = await lm.runCloseCheck();

      expect(closed).toBe(1);
      expect(eventRepo.update).toHaveBeenCalledWith('ev-8', expect.objectContaining({
        state: 'CLOSED',
      }));
      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('EventClosed');
      expect(published[0].payload).toHaveProperty('close_reason', 'INACTIVITY_7D');
    });

    it('returns 0 when no stale events', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      const closed = await lm.runCloseCheck();
      expect(closed).toBe(0);
    });
  });

  describe('scheduleRefreshes', () => {
    it('schedules refresh jobs for active events', async () => {
      eventRepo.findActiveEvents.mockResolvedValue([
        { id: 'ev-9', state: 'PUBLISHED' },
        { id: 'ev-10', state: 'UPDATING' },
      ]);

      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
      await lm.scheduleRefreshes();

      const jobs = scheduler.list();
      expect(jobs).toHaveLength(2);
      expect(jobs[0].jobKey).toMatch(/^refresh:ev-9:/);
      expect(jobs[1].jobKey).toMatch(/^refresh:ev-10:/);
    });
  });

  describe('FakeClock integration', () => {
    it('publish timing respects FakeClock advancement', async () => {
      const lm = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);

      // Create event → schedules publish at +5m
      await lm.handleEventCreated()(makeEventCreatedEnvelope('ev-11', 'art-11'));

      const publishAt = eventRepo.update.mock.calls[0][1].publishAt as Date;

      // Set event to return from findById
      eventRepo.findById.mockResolvedValue({
        id: 'ev-11',
        state: 'PENDING_PUBLISH',
        publishAt,
        publishedAt: null,
      });

      // Try publish before time elapses - should not publish
      await lm.executePublish('ev-11');
      expect(published.filter((e) => e.event_name === 'EventPublished')).toHaveLength(0);

      // Advance clock past publish time
      clock.advanceBy(PUBLISH_DELAY_MS + 1);

      // Now publish should work
      await lm.executePublish('ev-11');
      expect(published.filter((e) => e.event_name === 'EventPublished')).toHaveLength(1);
    });
  });
});
