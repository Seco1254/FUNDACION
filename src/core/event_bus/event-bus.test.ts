import { describe, it, expect, vi } from 'vitest';
import { EventBus, AuditLogWriter } from './dispatcher.js';
import { EventEnvelope } from './envelope.js';
import { assertValidEnvelope } from './validator.js';
import { ulid } from 'ulid';

function makeEnvelope(overrides?: Partial<EventEnvelope>): EventEnvelope {
  return {
    event_name: 'TestEvent',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: {
      trace_id: ulid(),
      span_id: ulid(),
      source_module: 'test',
    },
    payload: {},
    ...overrides,
  };
}

describe('EventEnvelope validation', () => {
  it('accepts a valid envelope', () => {
    const envelope = makeEnvelope();
    expect(() => assertValidEnvelope(envelope)).not.toThrow();
  });

  it('rejects envelope missing event_name', () => {
    const envelope = makeEnvelope();
    delete (envelope as any).event_name;
    expect(() => assertValidEnvelope(envelope)).toThrow('Invalid event envelope');
  });

  it('rejects envelope with missing trace fields', () => {
    const envelope = makeEnvelope();
    delete (envelope as any).trace.trace_id;
    expect(() => assertValidEnvelope(envelope)).toThrow('Invalid event envelope');
  });

  it('rejects envelope missing payload', () => {
    const envelope = makeEnvelope();
    delete (envelope as any).payload;
    expect(() => assertValidEnvelope(envelope)).toThrow('Invalid event envelope');
  });

  it('rejects envelope with invalid occurred_at format', () => {
    const envelope = makeEnvelope({ occurred_at: 'not-a-date' });
    expect(() => assertValidEnvelope(envelope)).toThrow('Invalid event envelope');
  });
});

describe('EventBus publish/subscribe', () => {
  it('executes handler on matching event_name', async () => {
    const bus = new EventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('TestEvent', 'testHandler', handler);
    const envelope = makeEnvelope();
    await bus.publish(envelope);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(envelope);
  });

  it('does not execute handler for non-matching event_name', async () => {
    const bus = new EventBus();
    const handler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('OtherEvent', 'otherHandler', handler);
    await bus.publish(makeEnvelope());

    expect(handler).not.toHaveBeenCalled();
  });

  it('executes multiple handlers for same event_name', async () => {
    const bus = new EventBus();
    const handler1 = vi.fn().mockResolvedValue(undefined);
    const handler2 = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('TestEvent', 'handler1', handler1);
    bus.subscribe('TestEvent', 'handler2', handler2);
    await bus.publish(makeEnvelope());

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });
});

describe('EventBus error handling', () => {
  it('writes audit log when handler fails', async () => {
    const bus = new EventBus();
    const mockWriter: AuditLogWriter = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    bus.setAuditLogWriter(mockWriter);

    const failingHandler = vi.fn().mockRejectedValue(new Error('handler boom'));
    bus.subscribe('TestEvent', 'failHandler', failingHandler);

    const envelope = makeEnvelope();
    await bus.publish(envelope);

    expect(mockWriter.write).toHaveBeenCalledOnce();
    expect(mockWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'OVERVIEW',
        entity_id: envelope.event_id,
        action: 'HANDLER_ERROR',
        trace_id: envelope.trace.trace_id,
        data: expect.objectContaining({
          event_name: 'TestEvent',
          handler_name: 'failHandler',
          error_message: 'handler boom',
        }),
      }),
    );
  });

  it('resolves entity_type to ARTICLE when payload has article_id', async () => {
    const bus = new EventBus();
    const mockWriter: AuditLogWriter = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    bus.setAuditLogWriter(mockWriter);

    bus.subscribe('TestEvent', 'fail', vi.fn().mockRejectedValue(new Error('boom')));

    const envelope = makeEnvelope({
      payload: { article_id: 'art-123' },
    });
    await bus.publish(envelope);

    expect(mockWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'ARTICLE',
        entity_id: 'art-123',
      }),
    );
  });

  it('resolves entity_type to EVENT when payload has event_id', async () => {
    const bus = new EventBus();
    const mockWriter: AuditLogWriter = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    bus.setAuditLogWriter(mockWriter);

    bus.subscribe('TestEvent', 'fail', vi.fn().mockRejectedValue(new Error('boom')));

    const envelope = makeEnvelope({
      payload: { event_id: 'evt-456' },
    });
    await bus.publish(envelope);

    expect(mockWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'EVENT',
        entity_id: 'evt-456',
      }),
    );
  });

  it('continues executing other handlers even if one fails', async () => {
    const bus = new EventBus();
    const mockWriter: AuditLogWriter = {
      write: vi.fn().mockResolvedValue(undefined),
    };
    bus.setAuditLogWriter(mockWriter);

    const failingHandler = vi.fn().mockRejectedValue(new Error('fail'));
    const successHandler = vi.fn().mockResolvedValue(undefined);

    bus.subscribe('TestEvent', 'failHandler', failingHandler);
    bus.subscribe('TestEvent', 'successHandler', successHandler);

    await bus.publish(makeEnvelope());

    expect(failingHandler).toHaveBeenCalledOnce();
    expect(successHandler).toHaveBeenCalledOnce();
  });
});
