import { EventEnvelope } from './envelope.js';
import { assertValidEnvelope } from './validator.js';
import { logger } from '../logging/logger.js';

export type EventHandler = (envelope: EventEnvelope) => Promise<void>;

export interface AuditLogWriter {
  write(entry: {
    entity_type: string;
    entity_id: string;
    action: string;
    trace_id: string;
    data: Record<string, unknown>;
  }): Promise<void>;
}

export class EventBus {
  private handlers: Map<string, { name: string; handler: EventHandler }[]> = new Map();
  private auditLogWriter: AuditLogWriter | null = null;

  setAuditLogWriter(writer: AuditLogWriter): void {
    this.auditLogWriter = writer;
  }

  subscribe(eventName: string, handlerName: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventName) ?? [];
    existing.push({ name: handlerName, handler });
    this.handlers.set(eventName, existing);
  }

  async publish(envelope: EventEnvelope): Promise<void> {
    assertValidEnvelope(envelope);

    const handlers = this.handlers.get(envelope.event_name) ?? [];

    logger.info(
      {
        event_name: envelope.event_name,
        event_id: envelope.event_id,
        trace_id: envelope.trace.trace_id,
        handler_count: handlers.length,
      },
      'event_published',
    );

    for (const { name, handler } of handlers) {
      try {
        await handler(envelope);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error(
          {
            event_name: envelope.event_name,
            handler_name: name,
            error: error.message,
            trace_id: envelope.trace.trace_id,
          },
          'handler_error',
        );

        const { entity_type, entity_id } = resolveEntity(envelope);

        if (this.auditLogWriter) {
          try {
            await this.auditLogWriter.write({
              entity_type,
              entity_id,
              action: 'HANDLER_ERROR',
              trace_id: envelope.trace.trace_id,
              data: {
                event_name: envelope.event_name,
                handler_name: name,
                error_message: error.message,
                stack: error.stack,
              },
            });
          } catch (auditErr) {
            logger.error(
              { error: auditErr instanceof Error ? auditErr.message : String(auditErr) },
              'audit_log_write_failed',
            );
          }
        }
      }
    }
  }
}

function resolveEntity(envelope: EventEnvelope): { entity_type: string; entity_id: string } {
  const payload = envelope.payload as Record<string, unknown>;
  if (typeof payload.article_id === 'string') {
    return { entity_type: 'ARTICLE', entity_id: payload.article_id };
  }
  if (typeof payload.event_id === 'string') {
    return { entity_type: 'EVENT', entity_id: payload.event_id };
  }
  return { entity_type: 'OVERVIEW', entity_id: envelope.event_id };
}
