import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { tabsRoutes } from './tabs.js';
import { feedRoutes } from './feed.js';
import { eventDetailRoutes, applyBiasSafeguard, type BiasSafeguardConfig } from './event-detail.js';
import { biasRoutes } from './bias.js';
import { metricsRoutes } from './metrics.js';
import { FeedService } from '../../modules/feed/service/feed-service.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';
import { Cache } from '../../core/cache/cache.js';
import { SingleFlight } from '../../core/cache/singleflight.js';
import { RateLimiter } from '../../core/http/rate-limiter.js';
import { metrics } from '../../core/metrics/metrics.js';

// Mock feed service
const mockFeedService = {
  getFeed: async () => ({ items: [], next_cursor: null }),
} as unknown as FeedService;

// Mock event repo
const mockEventRepo = {
  findByIdWithDetails: async (id: string) => {
    if (id === 'existing-id') {
      return {
        id: 'existing-id',
        state: 'DETECTED',
        t0: null, tLast: null, publishAt: null, publishedAt: null, closedAt: null,
        canonicalEventId: null, createdAt: new Date(),
        versions: [],
        eventArticles: [],
      };
    }
    return null;
  },
} as unknown as EventRepository;

const mockBiasRepo = {
  findMediaLevelByEvent: async () => [],
  findArticleLevelByEvent: async () => [],
  findByMediaAndEvent: async () => [],
} as unknown as BiasLabelRepository;

describe('Phase 5: ETag / 304 / Cache-Control', () => {
  let app: FastifyInstance;
  let cache: Cache;

  beforeAll(async () => {
    cache = new Cache({ maxEntries: 100, defaultTtlMs: 30000 });
    const sf = new SingleFlight();
    app = Fastify();
    await app.register(healthRoutes);
    await app.register(feedRoutes(mockFeedService, cache, sf));
    await app.register(eventDetailRoutes(mockEventRepo, undefined, mockBiasRepo, cache, sf));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    cache.clear();
  });

  it('returns ETag header on feed response', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeDefined();
    expect(response.headers.etag).toMatch(/^W\/"[a-f0-9]{16}"$/);
  });

  it('returns 304 when If-None-Match matches ETag', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    const etag = first.headers.etag;
    expect(etag).toBeDefined();

    const second = await app.inject({
      method: 'GET',
      url: '/v1/feed?tab=global',
      headers: { 'if-none-match': etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it('returns Cache-Control header on feed', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(response.headers['cache-control']).toContain('max-age=');
  });

  it('returns Vary header on feed', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(response.headers.vary).toContain('Accept');
  });

  it('returns ETag on event detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/events/existing-id' });
    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeDefined();
  });

  it('returns 304 on event detail with matching ETag', async () => {
    const first = await app.inject({ method: 'GET', url: '/v1/events/existing-id' });
    const etag = first.headers.etag;

    const second = await app.inject({
      method: 'GET',
      url: '/v1/events/existing-id',
      headers: { 'if-none-match': etag as string },
    });
    expect(second.statusCode).toBe(304);
  });

  it('serves from cache on second request', async () => {
    await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(cache.size).toBeGreaterThan(0);

    // Second request should hit cache
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(response.statusCode).toBe(200);
  });
});

describe('Phase 5: Cache invalidation', () => {
  it('delByPrefix clears feed entries on event version commit', () => {
    const cache = new Cache();
    cache.set('feed:global:', { items: [] });
    cache.set('feed:eco:', { items: [] });
    cache.set('event:ev-1', { data: true });

    // Simulate EventVersionCommitted invalidation
    cache.del('event:ev-1');
    cache.delByPrefix('feed:');

    expect(cache.get('event:ev-1')).toBeUndefined();
    expect(cache.get('feed:global:')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('del clears specific event on bias labels built', () => {
    const cache = new Cache();
    cache.set('event:ev-1', { data: true });
    cache.set('bias:ev-1:eltiempo', { data: true });
    cache.set('event:ev-2', { data: true });

    cache.del('event:ev-1');
    cache.delByPrefix('bias:ev-1:');

    expect(cache.get('event:ev-1')).toBeUndefined();
    expect(cache.get('bias:ev-1:eltiempo')).toBeUndefined();
    expect(cache.get('event:ev-2')).toEqual({ data: true });
  });
});

describe('Phase 5: Cursor validation', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(feedRoutes(mockFeedService));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 400 for invalid cursor (not base64)', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global&cursor=!!invalid!!' });
    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error).toBe('Invalid cursor');
  });

  it('returns 400 for base64 but wrong format (no pipe)', async () => {
    const cursor = Buffer.from('nodatenodelimiter').toString('base64');
    const response = await app.inject({ method: 'GET', url: `/v1/feed?tab=global&cursor=${cursor}` });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 for base64 with invalid date', async () => {
    const cursor = Buffer.from('not-a-date|some-id').toString('base64');
    const response = await app.inject({ method: 'GET', url: `/v1/feed?tab=global&cursor=${cursor}` });
    expect(response.statusCode).toBe(400);
  });

  it('accepts valid cursor format', async () => {
    const cursor = Buffer.from('2025-06-15T12:00:00.000Z|01ARZ3NDEKTSV4RRFFQ69G5FAV').toString('base64');
    const response = await app.inject({ method: 'GET', url: `/v1/feed?tab=global&cursor=${cursor}` });
    expect(response.statusCode).toBe(200);
  });

  it('accepts empty cursor (no cursor param)', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
    expect(response.statusCode).toBe(200);
  });
});

describe('Phase 5: Bias safeguards', () => {
  const strictConfig: BiasSafeguardConfig = {
    minConfidence: 0.6,
    minEvidenceRefs: 2,
  };

  it('degrades to INCONCLUSO when confidence is below threshold', () => {
    const label = {
      label_primary: 'CRITICO',
      label_secondary: 'ANTI_GOBIERNO',
      confidence: 0.3,
      intensity: 0.5,
      rationale: { evidence_refs: [{ type: 'article', id: 'art-1' }, { type: 'quote', id: 'q-1' }] },
    };
    const result = applyBiasSafeguard(label, strictConfig);
    expect(result.label_primary).toBe('INCONCLUSO');
    expect(result.label_secondary).toBeNull();
    expect(result.degraded).toBe(true);
    expect(result.degraded_reason).toBe('low_confidence');
  });

  it('degrades to INCONCLUSO when evidence refs insufficient', () => {
    const label = {
      label_primary: 'EMOCIONAL',
      label_secondary: null,
      confidence: 0.8,
      intensity: 0.5,
      rationale: { evidence_refs: [{ type: 'article', id: 'art-1' }] },
    };
    const result = applyBiasSafeguard(label, strictConfig);
    expect(result.label_primary).toBe('INCONCLUSO');
    expect(result.degraded).toBe(true);
    expect(result.degraded_reason).toBe('insufficient_evidence');
  });

  it('keeps original label when both thresholds met', () => {
    const label = {
      label_primary: 'CRITICO',
      label_secondary: 'ANTI_GOBIERNO',
      confidence: 0.8,
      intensity: 0.5,
      rationale: { evidence_refs: [{ type: 'article', id: 'a1' }, { type: 'quote', id: 'q1' }] },
    };
    const result = applyBiasSafeguard(label, strictConfig);
    expect(result.label_primary).toBe('CRITICO');
    expect(result.label_secondary).toBe('ANTI_GOBIERNO');
    expect(result.degraded).toBeUndefined();
  });

  it('degrades when rationale has no evidence_refs', () => {
    const label = {
      label_primary: 'NEUTRO',
      confidence: 0.9,
      rationale: { evidence_refs: [] },
    };
    const result = applyBiasSafeguard(label, strictConfig);
    expect(result.label_primary).toBe('INCONCLUSO');
    expect(result.degraded_reason).toBe('insufficient_evidence');
  });

  it('handles missing rationale gracefully', () => {
    const label = {
      label_primary: 'CRITICO',
      confidence: 0.9,
      rationale: null,
    };
    const result = applyBiasSafeguard(label, strictConfig);
    expect(result.label_primary).toBe('INCONCLUSO');
    expect(result.degraded).toBe(true);
  });
});

describe('Phase 5: Rate limiting integration', () => {
  it('returns 429 after exceeding limit', async () => {
    const limiter = new RateLimiter({ windowMs: 60000, max: 3 });
    const app = Fastify();
    app.addHook('onRequest', limiter.hook());
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/test' });
    await app.inject({ method: 'GET', url: '/test' });
    await app.inject({ method: 'GET', url: '/test' });

    const limited = await app.inject({ method: 'GET', url: '/test' });
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('Too Many Requests');
    expect(limited.headers['retry-after']).toBeDefined();

    limiter.destroy();
    await app.close();
  });
});

describe('Phase 5: Metrics endpoint', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(metricsRoutes);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    metrics.reset();
  });

  it('returns JSON metrics by default', async () => {
    metrics.incCounter('test.counter');
    const response = await app.inject({ method: 'GET', url: '/v1/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('application/json');
    const body = response.json();
    expect(body['test.counter']).toEqual({ type: 'counter', value: 1 });
  });

  it('returns Prometheus format when Accept: text/plain', async () => {
    metrics.incCounter('test.counter', 5);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/metrics',
      headers: { accept: 'text/plain' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('test_counter 5');
  });
});
