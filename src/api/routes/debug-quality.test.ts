import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugQualityRoutes } from './debug-quality.js';
import { QualitySnapshot } from '../../modules/quality/service/quality-snapshot.js';

function makeSnapshot(overrides: Partial<QualitySnapshot> = {}): QualitySnapshot {
  return {
    window: { from: '2026-02-19T00:00:00.000Z', to: '2026-02-20T00:00:00.000Z' },
    aggregates: {
      published_events: 5,
      boilerplate_rate: 0.05,
      mixed_event_rate: 0.2,
      split_proxy_rate: 0.1,
      distributions: {
        unique_media_count: { p50: 2, p75: 3, p90: 4, max: 5 },
        article_count: { p50: 3, p75: 5, p90: 8, max: 12 },
        evidence_level: { high: 2, medium: 2, low: 1, none: 0 },
      },
    },
    top_events: [
      {
        event_id: 'evt-1',
        headline: 'Test event',
        published_at: '2026-02-20T10:00:00.000Z',
        article_count: 5,
        unique_media_count: 3,
        evidence_level: 'high',
        importance_score: 3.5,
        flags: {
          mixed_event_flag: false,
          boilerplate_flag: false,
          split_suspect_flag: false,
        },
        reasons: [],
        sample_evidence: ['Something happened.', 'Context provided.'],
      },
    ],
    split_pairs: [],
    config: { window_hours: 24 },
    ...overrides,
  };
}

function makeService(snapshot: QualitySnapshot) {
  return { generate: async () => snapshot } as any;
}

describe('debug-quality routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns snapshot with correct shape', async () => {
    const snapshot = makeSnapshot();
    app = Fastify();
    app.register(debugQualityRoutes(makeService(snapshot)));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.window).toHaveProperty('from');
    expect(body.window).toHaveProperty('to');
    expect(body.aggregates).toHaveProperty('published_events', 5);
    expect(body.aggregates).toHaveProperty('boilerplate_rate');
    expect(body.aggregates).toHaveProperty('mixed_event_rate');
    expect(body.aggregates).toHaveProperty('split_proxy_rate');
    expect(body.aggregates.distributions).toHaveProperty('unique_media_count');
    expect(body.aggregates.distributions).toHaveProperty('article_count');
    expect(body.aggregates.distributions).toHaveProperty('evidence_level');
    expect(body.top_events).toHaveLength(1);
    expect(body.top_events[0]).toHaveProperty('event_id');
    expect(body.top_events[0]).toHaveProperty('flags');
    expect(body.top_events[0]).toHaveProperty('reasons');
    expect(body.top_events[0]).toHaveProperty('sample_evidence');
    expect(body.split_pairs).toEqual([]);
    expect(body.config).toHaveProperty('window_hours');
  });

  it('top_events items have all required fields', async () => {
    const snapshot = makeSnapshot();
    app = Fastify();
    app.register(debugQualityRoutes(makeService(snapshot)));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot' });
    const item = res.json().top_events[0];

    const required = [
      'event_id', 'headline', 'published_at', 'article_count',
      'unique_media_count', 'evidence_level', 'importance_score',
      'flags', 'reasons', 'sample_evidence',
    ];
    for (const key of required) {
      expect(item).toHaveProperty(key);
    }

    expect(item.flags).toHaveProperty('mixed_event_flag');
    expect(item.flags).toHaveProperty('boilerplate_flag');
    expect(item.flags).toHaveProperty('split_suspect_flag');
  });

  it('passes hours query param to service', async () => {
    let capturedHours: number | undefined;
    const service = {
      generate: async (h: number) => {
        capturedHours = h;
        return makeSnapshot();
      },
    } as any;

    app = Fastify();
    app.register(debugQualityRoutes(service));

    await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot?hours=72' });
    expect(capturedHours).toBe(72);
  });

  it('rejects invalid hours', async () => {
    app = Fastify();
    app.register(debugQualityRoutes(makeService(makeSnapshot())));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot?hours=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects hours out of range', async () => {
    app = Fastify();
    app.register(debugQualityRoutes(makeService(makeSnapshot())));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot?hours=1000' });
    expect(res.statusCode).toBe(400);
  });

  it('defaults to 24 hours when no query param', async () => {
    let capturedHours: number | undefined;
    const service = {
      generate: async (h: number) => {
        capturedHours = h;
        return makeSnapshot();
      },
    } as any;

    app = Fastify();
    app.register(debugQualityRoutes(service));

    await app.inject({ method: 'GET', url: '/v1/debug/quality/snapshot' });
    expect(capturedHours).toBe(24);
  });
});
