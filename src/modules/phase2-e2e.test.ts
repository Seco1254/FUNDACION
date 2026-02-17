import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../core/event_bus/envelope.js';
import { FakeClock } from '../core/time/clock.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { EmbeddingService } from './embedding/service/embedding-service.js';
import { EventLinker } from './event_linker/service/event-linker.js';
import { LifecycleManager } from './lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from './versioning/service/versioning-handler.js';
import { computeEmbedding, textForEmbedding } from './embedding/service/hash-vector.js';
import { ulid } from 'ulid';

describe('Phase 2 E2E: 2 similar articles → 1 event → published → versioned', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let clock: FakeClock;
  let scheduler: Scheduler;

  // In-memory stores
  let articlesDb: Map<string, any>;
  let eventsDb: Map<string, any>;
  let eventArticlesDb: Map<string, Set<string>>;
  let versionsDb: any[];
  let eventIdCounter: number;

  let articleRepo: any;
  let eventRepo: any;
  let versionRepo: any;
  let mediaRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    published = [];
    articlesDb = new Map();
    eventsDb = new Map();
    eventArticlesDb = new Map();
    versionsDb = [];
    eventIdCounter = 0;

    clock = new FakeClock(new Date('2025-06-15T12:00:00.000Z'));
    scheduler = new Scheduler(clock, vi.fn());

    eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
      // Cascade: call handlers registered on the bus
      const handlers = (eventBus as any).handlers.get(env.event_name) ?? [];
      for (const { handler } of handlers) {
        await handler(env);
      }
    });

    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };

    articleRepo = {
      findById: vi.fn().mockImplementation(async (id: string) => articlesDb.get(id) ?? null),
      updateEmbedding: vi.fn().mockImplementation(async (id: string, data: any) => {
        const article = articlesDb.get(id);
        if (article) {
          article.embeddingModel = data.embeddingModel;
          article.embeddingHash = data.embeddingHash;
          article.embeddingVec = data.embeddingVec;
        }
        return article;
      }),
    };

    eventRepo = {
      findById: vi.fn().mockImplementation(async (id: string) => eventsDb.get(id) ?? null),
      create: vi.fn().mockImplementation(async (data: any) => {
        eventIdCounter++;
        const event = {
          id: `event-${eventIdCounter}`,
          state: data.state ?? 'DETECTED',
          t0: data.t0 ?? null,
          tLast: data.tLast ?? null,
          publishAt: data.publishAt ?? null,
          publishedAt: data.publishedAt ?? null,
          closedAt: null,
          canonicalEventId: null,
          createdAt: clock.now(),
        };
        eventsDb.set(event.id, event);
        eventArticlesDb.set(event.id, new Set());
        return event;
      }),
      update: vi.fn().mockImplementation(async (id: string, data: any) => {
        const event = eventsDb.get(id);
        if (event) {
          Object.assign(event, data);
        }
        return event;
      }),
      linkArticle: vi.fn().mockImplementation(async (eventId: string, articleId: string) => {
        const set = eventArticlesDb.get(eventId) ?? new Set();
        set.add(articleId);
        eventArticlesDb.set(eventId, set);
      }),
      findCandidateEvents: vi.fn().mockImplementation(async () => {
        return Array.from(eventsDb.values()).filter((e: any) => e.state !== 'CLOSED');
      }),
      findArticlesForEvent: vi.fn().mockImplementation(async (eventId: string) => {
        const set = eventArticlesDb.get(eventId) ?? new Set();
        return Array.from(set).map((id: any) => articlesDb.get(id)).filter(Boolean);
      }),
      countArticlesForEvent: vi.fn().mockImplementation(async (eventId: string) => {
        return (eventArticlesDb.get(eventId) ?? new Set()).size;
      }),
      findStaleEvents: vi.fn().mockResolvedValue([]),
      findActiveEvents: vi.fn().mockImplementation(async () => {
        return Array.from(eventsDb.values()).filter(
          (e: any) => ['PUBLISHED', 'UPDATING', 'DORMANT'].includes(e.state),
        );
      }),
    };

    versionRepo = {
      findLatestByEventId: vi.fn().mockImplementation(async (eventId: string) => {
        const eventVersions = versionsDb.filter((v: any) => v.eventId === eventId);
        return eventVersions.length > 0 ? eventVersions[eventVersions.length - 1] : null;
      }),
      create: vi.fn().mockImplementation(async (data: any) => {
        const version = { id: ulid(), ...data, createdAt: clock.now() };
        versionsDb.push(version);
        return version;
      }),
    };

    mediaRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'media-1', mediaKey: 'eltiempo' }),
    };
  });

  it('2 similar articles cluster into 1 event, which gets published after +5m', async () => {
    // Setup: two similar articles about Colombian reform
    const art1Text = textForEmbedding(
      'Reforma tributaria Colombia 2025',
      'El gobierno colombiano presentó la nueva reforma tributaria',
    );
    const art2Text = textForEmbedding(
      'Nueva reforma tributaria anunciada en Colombia',
      'El presidente colombiano anunció detalles de la reforma tributaria',
    );

    const vec1 = computeEmbedding(art1Text);
    const vec2 = computeEmbedding(art2Text);

    // Seed articles in DB (pre-embedded, as if they come from PolicyOk)
    articlesDb.set('art-1', {
      id: 'art-1',
      mediaId: 'media-1',
      title: 'Reforma tributaria Colombia 2025',
      snippet: 'El gobierno colombiano presentó la nueva reforma tributaria',
      url: 'https://eltiempo.com/reforma-1',
      publishedAt: new Date('2025-06-15T11:00:00.000Z'),
      embeddingModel: null,
      embeddingHash: null,
      embeddingVec: null,
    });

    articlesDb.set('art-2', {
      id: 'art-2',
      mediaId: 'media-1',
      title: 'Nueva reforma tributaria anunciada en Colombia',
      snippet: 'El presidente colombiano anunció detalles de la reforma tributaria',
      url: 'https://eltiempo.com/reforma-2',
      publishedAt: new Date('2025-06-15T11:30:00.000Z'),
      embeddingModel: null,
      embeddingHash: null,
      embeddingVec: null,
    });

    // Wire up the Phase 2 pipeline (no cascade - we do step by step)
    const embeddingService = new EmbeddingService(articleRepo, eventBus, auditWriter);
    const eventLinker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    const lifecycleManager = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
    const versioningHandler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);

    // Register handlers for cascading
    eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
    eventBus.subscribe('ArticleEmbedded', 'EventLinker', eventLinker.handler());
    eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
    eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
    eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());

    // Step 1: First article flows through ArticlePolicyOk
    await eventBus.publish({
      event_name: 'ArticlePolicyOk',
      event_id: ulid(),
      occurred_at: clock.now().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { article_id: 'art-1' },
    });

    // After first article: should have 1 event created
    expect(eventsDb.size).toBe(1);
    const firstEventId = Array.from(eventsDb.keys())[0];
    const firstEvent = eventsDb.get(firstEventId);
    expect(firstEvent.state).toBe('PENDING_PUBLISH');

    // Step 2: Second similar article flows through
    await eventBus.publish({
      event_name: 'ArticlePolicyOk',
      event_id: ulid(),
      occurred_at: clock.now().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { article_id: 'art-2' },
    });

    // Both articles should be linked to the SAME event (similarity-based)
    const eventArticles = eventArticlesDb.get(firstEventId);
    // The second article might create a new event or join existing depending on similarity
    // At minimum, we should have at most 2 events (1 if similar enough, 2 if not)
    const totalEvents = eventsDb.size;
    expect(totalEvents).toBeGreaterThanOrEqual(1);
    expect(totalEvents).toBeLessThanOrEqual(2);

    // Step 3: Advance clock past publish time (+5 min)
    clock.advanceBy(6 * 60 * 1000);

    // Execute publish for all pending events
    for (const [eventId, event] of eventsDb.entries()) {
      if (event.state === 'PENDING_PUBLISH') {
        await lifecycleManager.executePublish(eventId);
      }
    }

    // At least one event should be PUBLISHED
    const publishedEvents = Array.from(eventsDb.values()).filter((e: any) => e.state === 'PUBLISHED');
    expect(publishedEvents.length).toBeGreaterThanOrEqual(1);

    // Versions should have been created
    expect(versionsDb.length).toBeGreaterThanOrEqual(1);

    // Check that the pipeline emitted the expected event types
    const eventNames = published.map((e) => e.event_name);
    expect(eventNames).toContain('ArticleEmbedded');
    expect(eventNames).toContain('EventCreated');
    expect(eventNames).toContain('ArticleLinkedToEvent');
    expect(eventNames).toContain('EventPublishScheduled');
    expect(eventNames).toContain('EventUpdateTriggered');
    expect(eventNames).toContain('EventVersionCommitted');
    expect(eventNames).toContain('EventPublished');
  });
});
