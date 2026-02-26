import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugCoherenceRoutes } from './debug-coherence.js';

/**
 * Build a mock PrismaClient that returns event versions with coherence_gate in packet_json.
 */
function makePrisma(versions: any[]) {
  return {
    eventVersion: {
      findMany: vi.fn().mockResolvedValue(versions),
    },
  } as any;
}

function makeVersion(
  eventId: string,
  status: 'PASS' | 'FAIL',
  metrics: {
    avg_cosine: number | null;
    entity_jaccard: number | null;
    title_jaccard: number | null;
    stddev_drift: number | null;
    article_count: number;
  },
  failedChecks: string[] = [],
) {
  return {
    eventId,
    packetJson: {
      coherence_gate: {
        status,
        failed_checks: failedChecks,
        metrics,
        thresholds: {
          min_avg_cosine: 0.55,
          min_entity_jaccard: 0.05,
          min_title_jaccard: 0.10,
          max_stddev_drift: 0.35,
        },
      },
    },
  };
}

describe('debug-coherence routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns deterministic response shape', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', {
        avg_cosine: 0.72,
        entity_jaccard: 0.15,
        title_jaccard: 0.25,
        stddev_drift: 0.08,
        article_count: 3,
      }),
      makeVersion('evt-2', 'FAIL', {
        avg_cosine: 0.38,
        entity_jaccard: 0.02,
        title_jaccard: 0.04,
        stddev_drift: 0.45,
        article_count: 4,
      }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('total_events', 2);
    expect(body).toHaveProperty('pass_rate');
    expect(body).toHaveProperty('fail_rate');
    expect(body).toHaveProperty('pass_count', 1);
    expect(body).toHaveProperty('fail_count', 1);
    expect(body).toHaveProperty('percentiles');
    expect(body.percentiles).toHaveProperty('avg_cosine');
    expect(body.percentiles).toHaveProperty('entity_jaccard');
    expect(body.percentiles).toHaveProperty('title_jaccard');
    expect(body.percentiles).toHaveProperty('stddev_drift');
    expect(body.percentiles.avg_cosine).toHaveProperty('p25');
    expect(body.percentiles.avg_cosine).toHaveProperty('p50');
    expect(body.percentiles.avg_cosine).toHaveProperty('p75');
    expect(body).toHaveProperty('distribution_by_article_count');
    expect(body).toHaveProperty('fail_reason_frequency');
  });

  it('computes pass_rate and fail_rate correctly', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.08, article_count: 3 }),
      makeVersion('evt-3', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 4 }, ['low_embedding_cohesion', 'title_content_mismatch']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.pass_rate).toBeCloseTo(2 / 3, 5);
    expect(body.fail_rate).toBeCloseTo(1 / 3, 5);
  });

  it('returns fail_reason_frequency for failed checks', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 3 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.4, entity_jaccard: 0.03, title_jaccard: 0.05, stddev_drift: 0.4, article_count: 2 }, ['low_embedding_cohesion', 'title_content_mismatch']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.fail_reason_frequency.low_embedding_cohesion).toBe(2);
    expect(body.fail_reason_frequency.low_entity_overlap).toBe(1);
    expect(body.fail_reason_frequency.title_content_mismatch).toBe(1);
  });

  it('returns distribution_by_article_count', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.1, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.03, article_count: 2 }),
      makeVersion('evt-3', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 5 }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.distribution_by_article_count[2]).toEqual({ total: 2, pass: 2, fail: 0 });
    expect(body.distribution_by_article_count[5]).toEqual({ total: 1, pass: 0, fail: 1 });
  });

  it('handles empty results', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.total_events).toBe(0);
    expect(body.pass_rate).toBe(0);
    expect(body.fail_rate).toBe(0);
    expect(body.percentiles.avg_cosine).toEqual({ p25: 0, p50: 0, p75: 0 });
  });

  it('rejects invalid limit', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects out-of-range limit', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=5000' });
    expect(res.statusCode).toBe(400);
  });

  it('passes limit to prisma findMany', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=50' });
    expect(prisma.eventVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });
});
