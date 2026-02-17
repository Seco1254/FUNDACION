import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus } from '../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../core/event_bus/envelope.js';
import { FakeClock } from '../core/time/clock.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { EmbeddingService } from './embedding/service/embedding-service.js';
import { EventLinker } from './event_linker/service/event-linker.js';
import { LifecycleManager } from './lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from './versioning/service/versioning-handler.js';
import { ClaimQuoteExtractor } from './claims/service/claim-extractor.js';
import { OverviewGenerator } from './overview/service/overview-generator.js';
import { computeEmbedding, textForEmbedding } from './embedding/service/hash-vector.js';
import { ulid } from 'ulid';

describe('Phase 3 E2E: articles → event → version → claims → overview PASS/FAIL', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let clock: FakeClock;
  let scheduler: Scheduler;

  // In-memory stores
  let articlesDb: Map<string, any>;
  let eventsDb: Map<string, any>;
  let eventArticlesDb: Map<string, Set<string>>;
  let versionsDb: any[];
  let claimsDb: any[];
  let quotesDb: any[];
  let eventIdCounter: number;

  let articleRepo: any;
  let eventRepo: any;
  let versionRepo: any;
  let claimRepo: any;
  let mediaRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    published = [];
    articlesDb = new Map();
    eventsDb = new Map();
    eventArticlesDb = new Map();
    versionsDb = [];
    claimsDb = [];
    quotesDb = [];
    eventIdCounter = 0;

    clock = new FakeClock(new Date('2025-06-15T12:00:00.000Z'));
    scheduler = new Scheduler(clock, vi.fn());

    eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
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
        if (article) Object.assign(article, data);
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
        if (event) Object.assign(event, data);
        return event;
      }),
      linkArticle: vi.fn().mockImplementation(async (eventId: string, articleId: string) => {
        const set = eventArticlesDb.get(eventId) ?? new Set();
        set.add(articleId);
        eventArticlesDb.set(eventId, set);
      }),
      findCandidateEvents: vi.fn().mockImplementation(async () =>
        Array.from(eventsDb.values()).filter((e: any) => e.state !== 'CLOSED'),
      ),
      findArticlesForEvent: vi.fn().mockImplementation(async (eventId: string) => {
        const set = eventArticlesDb.get(eventId) ?? new Set();
        return Array.from(set).map((id: any) => articlesDb.get(id)).filter(Boolean);
      }),
      countArticlesForEvent: vi.fn().mockImplementation(async (eventId: string) =>
        (eventArticlesDb.get(eventId) ?? new Set()).size,
      ),
      findStaleEvents: vi.fn().mockResolvedValue([]),
      findActiveEvents: vi.fn().mockImplementation(async () =>
        Array.from(eventsDb.values()).filter((e: any) => ['PUBLISHED', 'UPDATING', 'DORMANT'].includes(e.state)),
      ),
    };

    versionRepo = {
      findLatestByEventId: vi.fn().mockImplementation(async (eventId: string) => {
        const evVersions = versionsDb.filter((v: any) => v.eventId === eventId);
        return evVersions.length > 0 ? evVersions[evVersions.length - 1] : null;
      }),
      findById: vi.fn().mockImplementation(async (id: string) =>
        versionsDb.find((v: any) => v.id === id) ?? null,
      ),
      create: vi.fn().mockImplementation(async (data: any) => {
        const version = { id: `ver-${versionsDb.length + 1}`, ...data, createdAt: clock.now() };
        versionsDb.push(version);
        return version;
      }),
      update: vi.fn().mockImplementation(async (id: string, data: any) => {
        const version = versionsDb.find((v: any) => v.id === id);
        if (version) Object.assign(version, data);
        return version;
      }),
    };

    claimRepo = {
      countClaimsByVersion: vi.fn().mockImplementation(async (eventId: string, versionId: string) =>
        claimsDb.filter((c: any) => c.eventId === eventId && c.versionId === versionId).length,
      ),
      createClaim: vi.fn().mockImplementation(async (data: any) => {
        const claim = { id: `claim-${claimsDb.length + 1}`, ...data, createdAt: clock.now() };
        claimsDb.push(claim);
        return claim;
      }),
      createQuote: vi.fn().mockImplementation(async (data: any) => {
        const quote = { id: `quote-${quotesDb.length + 1}`, ...data, createdAt: clock.now() };
        quotesDb.push(quote);
        return quote;
      }),
      findClaimsWithQuotesByVersion: vi.fn().mockImplementation(async (eventId: string, versionId: string) => {
        const vClaims = claimsDb.filter((c: any) => c.eventId === eventId && c.versionId === versionId);
        return vClaims.map((c: any) => ({
          ...c,
          quotes: quotesDb.filter((q: any) => q.claimId === c.id).map((q: any) => {
            const article = articlesDb.get(q.articleId);
            return {
              ...q,
              article: article ? { url: article.url, media: { mediaKey: 'eltiempo' } } : null,
            };
          }),
        }));
      }),
    };

    mediaRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'media-1', mediaKey: 'eltiempo' }),
    };
  });

  it('full pipeline: 2 articles from different media → claims → overview with gate status', async () => {
    // Two articles from different media with overlapping long sentences about reform
    articlesDb.set('art-1', {
      id: 'art-1',
      mediaId: 'media-1',
      title: 'El gobierno colombiano presentó la reforma tributaria que aumentará impuestos en un 15 por ciento',
      snippet: 'Según el ministro de hacienda, la reforma busca recaudar 30 billones de pesos para financiar programas sociales del gobierno nacional.',
      url: 'https://eltiempo.com/reforma',
      publishedAt: new Date('2025-06-15T11:00:00.000Z'),
      embeddingModel: null,
      embeddingHash: null,
      embeddingVec: null,
    });

    articlesDb.set('art-2', {
      id: 'art-2',
      mediaId: 'media-2',
      title: 'Nueva reforma tributaria presentada por el gobierno colombiano afectará a grandes empresas del país',
      snippet: 'El presidente colombiano declaró que la reforma tributaria aumentará impuestos en un 15 por ciento a las empresas con ingresos superiores.',
      url: 'https://elespectador.com/reforma',
      publishedAt: new Date('2025-06-15T11:30:00.000Z'),
      embeddingModel: null,
      embeddingHash: null,
      embeddingVec: null,
    });

    // Wire full pipeline
    const embeddingService = new EmbeddingService(articleRepo, eventBus, auditWriter);
    const eventLinker = new EventLinker(articleRepo, eventRepo, eventBus, auditWriter, clock);
    const lifecycleManager = new LifecycleManager(eventRepo, eventBus, auditWriter, scheduler, clock);
    const versioningHandler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    const claimExtractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter);
    const overviewGen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);

    eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
    eventBus.subscribe('ArticleEmbedded', 'EventLinker', eventLinker.handler());
    eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
    eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
    eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());
    eventBus.subscribe('EventVersionCommitted', 'ClaimQuoteExtractor', claimExtractor.handler());
    eventBus.subscribe('ClaimGraphBuilt', 'OverviewGenerator', overviewGen.handler());

    // Push first article
    await eventBus.publish({
      event_name: 'ArticlePolicyOk',
      event_id: ulid(),
      occurred_at: clock.now().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { article_id: 'art-1' },
    });

    // Push second article
    await eventBus.publish({
      event_name: 'ArticlePolicyOk',
      event_id: ulid(),
      occurred_at: clock.now().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { article_id: 'art-2' },
    });

    // Advance clock past publish time and publish
    clock.advanceBy(6 * 60 * 1000);
    for (const [eventId, event] of eventsDb.entries()) {
      if (event.state === 'PENDING_PUBLISH') {
        await lifecycleManager.executePublish(eventId);
      }
    }

    // Verify claims were created
    expect(claimsDb.length).toBeGreaterThan(0);
    expect(quotesDb.length).toBeGreaterThan(0);

    // Verify versions were created and updated with overview
    expect(versionsDb.length).toBeGreaterThanOrEqual(1);

    // Check that the full event chain was emitted
    const eventNames = published.map((e) => e.event_name);
    expect(eventNames).toContain('ArticleEmbedded');
    expect(eventNames).toContain('EventCreated');
    expect(eventNames).toContain('EventVersionCommitted');
    expect(eventNames).toContain('ClaimGraphBuilt');
    expect(eventNames).toContain('OverviewGenerated');

    // Check the OverviewGenerated event has a gate_status
    const overviewEvent = published.find((e) => e.event_name === 'OverviewGenerated');
    expect(overviewEvent).toBeDefined();
    expect(['PASS', 'FAIL']).toContain((overviewEvent!.payload as any).gate_status);

    // Verify versionRepo.update was called with overview in packet
    const updateCalls = versionRepo.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThan(0);
    const lastUpdate = updateCalls[updateCalls.length - 1];
    expect(lastUpdate[1].packetJson).toHaveProperty('overview');
    expect(lastUpdate[1].packetJson.overview).toHaveProperty('sections');
    expect(lastUpdate[1].packetJson).toHaveProperty('claims_count');
    expect(lastUpdate[1].packetJson).toHaveProperty('quality_flags');
  });
});
