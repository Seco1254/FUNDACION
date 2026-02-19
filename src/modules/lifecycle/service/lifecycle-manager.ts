import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { Scheduler } from '../../../core/scheduler/scheduler.js';
import { Clock } from '../../../core/time/clock.js';
import { addMs } from '../../../core/time/runtime-time.js';
import { logger } from '../../../core/logging/logger.js';

const PUBLISH_DELAY_MS = parseInt(process.env.PUBLISH_DELAY_MS ?? String(5 * 60 * 1000), 10);
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class LifecycleManager {
  constructor(
    private eventRepo: EventRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private scheduler: Scheduler,
    private clock: Clock,
  ) {}

  handleEventCreated(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, seed_article_id } = envelope.payload as {
        event_id: string;
        seed_article_id: string;
      };
      const traceId = envelope.trace.trace_id;
      const now = this.clock.now();
      const publishAt = addMs(now, PUBLISH_DELAY_MS);

      await this.eventRepo.update(event_id, {
        state: 'PENDING_PUBLISH',
        publishAt,
      });

      this.scheduler.register(`publish:${event_id}`, publishAt, { eventId: event_id });

      await this.auditWriter.write({
        entity_type: 'EVENT',
        entity_id: event_id,
        action: 'PUBLISH_SCHEDULED',
        trace_id: traceId,
        data: { publish_at: publishAt.toISOString(), seed_article_id },
      });

      await this.eventBus.publish({
        event_name: 'EventPublishScheduled',
        event_id: ulid(),
        occurred_at: now.toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'lifecycle' },
        payload: { event_id, publish_at: publishAt.toISOString() },
      });
    };
  }

  handleArticleLinked(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { article_id, event_id, link_action } = envelope.payload as {
        article_id: string;
        event_id: string;
        link_action: string;
      };
      const traceId = envelope.trace.trace_id;
      const now = this.clock.now();

      if (link_action === 'LINKED_EXISTING') {
        await this.eventRepo.update(event_id, { tLast: now });
      }

      await this.eventBus.publish({
        event_name: 'EventUpdateTriggered',
        event_id: ulid(),
        occurred_at: now.toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'lifecycle' },
        payload: { event_id, trigger: 'NEW_ARTICLE' },
      });
    };
  }

  async executePublish(eventId: string): Promise<void> {
    const startMs = Date.now();
    const now = this.clock.now();
    const event = await this.eventRepo.findById(eventId);

    if (!event) {
      logger.info({ event_id: eventId }, 'publish_skip_not_found');
      return;
    }
    if (event.state === 'CLOSED') {
      logger.info({ event_id: eventId, state: event.state }, 'publish_skip_closed');
      return;
    }
    if (event.state === 'PUBLISHED') {
      logger.info({ event_id: eventId, state: event.state }, 'publish_skip_already_published');
      return;
    }
    if (event.publishAt && now < event.publishAt) {
      logger.info({ event_id: eventId, publish_at: event.publishAt.toISOString(), now: now.toISOString() }, 'publish_skip_not_due');
      return;
    }

    logger.info({ event_id: eventId, previous_state: event.state }, 'publish_start');

    await this.eventRepo.update(eventId, {
      state: 'PUBLISHED',
      publishedAt: event.publishedAt ?? now,
    });

    const traceId = ulid();

    await this.auditWriter.write({
      entity_type: 'EVENT',
      entity_id: eventId,
      action: 'PUBLISHED',
      trace_id: traceId,
      data: { published_at: now.toISOString() },
    });

    await this.eventBus.publish({
      event_name: 'EventPublished',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'lifecycle' },
      payload: { event_id: eventId, published_at: now.toISOString() },
    });

    logger.info({ event_id: eventId, duration_ms: Date.now() - startMs }, 'publish_complete');
  }

  async executeRefresh(eventId: string): Promise<void> {
    const event = await this.eventRepo.findById(eventId);
    if (!event || event.state === 'CLOSED') return;

    const traceId = ulid();
    const now = this.clock.now();

    await this.eventBus.publish({
      event_name: 'EventUpdateTriggered',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'lifecycle' },
      payload: { event_id: eventId, trigger: 'REFRESH_JOB' },
    });
  }

  async runCloseCheck(): Promise<number> {
    const now = this.clock.now();
    const before = addMs(now, -SEVEN_DAYS_MS);
    const staleEvents = await this.eventRepo.findStaleEvents(before);
    let closed = 0;

    for (const event of staleEvents) {
      await this.eventRepo.update(event.id, {
        state: 'CLOSED',
        closedAt: now,
      });

      const traceId = ulid();

      await this.auditWriter.write({
        entity_type: 'EVENT',
        entity_id: event.id,
        action: 'CLOSED',
        trace_id: traceId,
        data: { closed_at: now.toISOString(), close_reason: 'INACTIVITY_7D' },
      });

      await this.eventBus.publish({
        event_name: 'EventClosed',
        event_id: ulid(),
        occurred_at: now.toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'lifecycle' },
        payload: { event_id: event.id, closed_at: now.toISOString(), close_reason: 'INACTIVITY_7D' },
      });

      closed++;
    }

    return closed;
  }

  async scheduleRefreshes(): Promise<void> {
    const events = await this.eventRepo.findActiveEvents();
    const now = this.clock.now();
    const slotMs = 30 * 60 * 1000;
    const slot = new Date(Math.ceil(now.getTime() / slotMs) * slotMs);
    const slotISO = slot.toISOString();

    for (const event of events) {
      const jobKey = `refresh:${event.id}:${slotISO}`;
      this.scheduler.register(jobKey, slot, { eventId: event.id, trigger: 'REFRESH_JOB' });
    }
  }
}
