import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventLinker } from './event-linker.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { FakeClock } from '../../../core/time/clock.js';
import { computeEmbedding, textForEmbedding } from '../../embedding/service/hash-vector.js';
import { ulid } from 'ulid';

function makeEnvelope(articleId: string): EventEnvelope {
  return {
    event_name: 'ArticleEmbedded',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { article_id: articleId },
  };
}

describe('EventLinker', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let articleRepo: any;
  let eventRepo: any;
  let auditWriter: any;
  let clock: FakeClock;

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
    clock = new FakeClock(new Date('2025-06-15T12:00:00.000Z'));
    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
    articleRepo = {
      findById: vi.fn(),
    };
    eventRepo = {
      findCandidateEvents: vi.fn().mockResolvedValue([]),
      findArticlesForEvent: vi.fn().mockResolvedValue([]),
      linkArticle: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation(async (data: any) => ({
        id: 'new-event-1',
        ...data,
        createdAt: clock.now(),
      })),
      countArticlesForEvent: vi.fn().mockResolvedValue(1),
      findById: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    };
  });

  it('creates new event when no candidates exist', async () => {
    const vec = computeEmbedding(textForEmbedding('Reforma tributaria', 'Gobierno anuncia reforma'));
    articleRepo.findById.mockResolvedValue({
      id: 'art-1',
      embeddingVec: vec,
      title: 'Reforma tributaria',
    });

    const linker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    await linker.handler()(makeEnvelope('art-1'));

    expect(eventRepo.create).toHaveBeenCalledOnce();
    expect(eventRepo.linkArticle).toHaveBeenCalledWith('new-event-1', 'art-1');

    const eventNames = published.map((e) => e.event_name);
    expect(eventNames).toContain('EventCreated');
    expect(eventNames).toContain('ArticleLinkedToEvent');

    const linkedEvent = published.find((e) => e.event_name === 'ArticleLinkedToEvent');
    expect(linkedEvent?.payload).toHaveProperty('link_action', 'TRIGGER_CREATE');
  });

  it('links to existing event when similarity >= theta_join', async () => {
    const text = textForEmbedding('Reforma tributaria Colombia', 'Gobierno colombiano anuncia reforma tributaria');
    const vec = computeEmbedding(text);

    articleRepo.findById.mockResolvedValue({
      id: 'art-2',
      embeddingVec: vec,
    });

    const existingEventId = 'existing-ev-1';
    eventRepo.findCandidateEvents.mockResolvedValue([
      { id: existingEventId, t0: new Date('2025-06-15T10:00:00.000Z') },
    ]);

    // Return articles with same/similar embedding for the existing event
    eventRepo.findArticlesForEvent.mockResolvedValue([
      { id: 'art-existing', embeddingVec: vec },
    ]);

    const linker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    await linker.handler()(makeEnvelope('art-2'));

    expect(eventRepo.create).not.toHaveBeenCalled();
    expect(eventRepo.linkArticle).toHaveBeenCalledWith(existingEventId, 'art-2');

    const linked = published.find((e) => e.event_name === 'ArticleLinkedToEvent');
    expect(linked?.payload).toHaveProperty('link_action', 'LINKED_EXISTING');
    expect(linked?.payload).toHaveProperty('event_id', existingEventId);
  });

  it('creates new event when similarity < theta_join', async () => {
    const vec1 = computeEmbedding(textForEmbedding('Reforma tributaria Colombia', 'Gobierno anuncia reforma'));
    const vec2 = computeEmbedding(textForEmbedding('Fútbol Argentina mundial Qatar', 'Selección argentina gana mundial'));

    articleRepo.findById.mockResolvedValue({
      id: 'art-3',
      embeddingVec: vec2,
    });

    eventRepo.findCandidateEvents.mockResolvedValue([
      { id: 'ev-tax', t0: new Date('2025-06-15T10:00:00.000Z') },
    ]);
    eventRepo.findArticlesForEvent.mockResolvedValue([
      { id: 'art-tax', embeddingVec: vec1 },
    ]);

    const linker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    await linker.handler()(makeEnvelope('art-3'));

    expect(eventRepo.create).toHaveBeenCalledOnce();
    const eventNames = published.map((e) => e.event_name);
    expect(eventNames).toContain('EventCreated');
  });

  it('does nothing when article has no embedding', async () => {
    articleRepo.findById.mockResolvedValue({
      id: 'art-4',
      embeddingVec: null,
    });

    const linker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    await linker.handler()(makeEnvelope('art-4'));

    expect(eventRepo.create).not.toHaveBeenCalled();
    expect(eventRepo.linkArticle).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('writes audit trail for all decisions', async () => {
    const vec = computeEmbedding(textForEmbedding('Test', 'Article'));
    articleRepo.findById.mockResolvedValue({
      id: 'art-5',
      embeddingVec: vec,
    });

    const linker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    await linker.handler()(makeEnvelope('art-5'));

    expect(auditWriter.write).toHaveBeenCalled();
    const auditCall = auditWriter.write.mock.calls[0][0];
    expect(auditCall.entity_type).toBe('EVENT');
    expect(auditCall.action).toBe('CREATED_EVENT');
  });
});
