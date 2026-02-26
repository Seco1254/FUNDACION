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
  status: 'PASS' | 'FAIL' | 'NA',
  metrics: {
    avg_cosine: number | null;
    entity_jaccard: number | null;
    title_jaccard: number | null;
    stddev_drift: number | null;
    article_count: number;
  },
  failedChecks: string[] = [],
  headline: string | null = null,
) {
  return {
    eventId,
    createdAt: new Date('2026-02-26T10:00:00Z'),
    headline,
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

describe('debug-coherence routes — summary', () => {
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
    expect(body).toHaveProperty('na_rate');
    expect(body).toHaveProperty('pass_count', 1);
    expect(body).toHaveProperty('fail_count', 1);
    expect(body).toHaveProperty('na_count', 0);
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

  it('counts NA status correctly', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: 0.5, stddev_drift: null, article_count: 1 }),
      makeVersion('evt-2', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: null, stddev_drift: null, article_count: 0 }),
      makeVersion('evt-3', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.na_count).toBe(2);
    expect(body.pass_count).toBe(1);
    expect(body.fail_count).toBe(0);
    expect(body.na_rate).toBeCloseTo(2 / 3, 5);
  });

  it('filters by min_articles', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: 0.5, stddev_drift: null, article_count: 1 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-3', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 4 }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?min_articles=2' });
    const body = res.json();

    // Only evt-2 and evt-3 should be included (article_count >= 2)
    expect(body.total_events).toBe(2);
    expect(body.pass_count).toBe(1);
    expect(body.fail_count).toBe(1);
    expect(body.na_count).toBe(0);
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

  it('distribution_by_article_count includes na', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: null, stddev_drift: null, article_count: 1 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.1, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-3', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.03, article_count: 2 }),
      makeVersion('evt-4', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 5 }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.distribution_by_article_count[1]).toEqual({ total: 1, pass: 0, fail: 0, na: 1 });
    expect(body.distribution_by_article_count[2]).toEqual({ total: 2, pass: 2, fail: 0, na: 0 });
    expect(body.distribution_by_article_count[5]).toEqual({ total: 1, pass: 0, fail: 1, na: 0 });
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
    expect(body.na_rate).toBe(0);
    expect(body.percentiles.avg_cosine).toEqual({ p25: 0, p50: 0, p75: 0 });
  });

  it('rejects invalid limit', async () => {
    app = Fastify();
    app.register(debugCoherenceRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects out-of-range limit', async () => {
    app = Fastify();
    app.register(debugCoherenceRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=5000' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid min_articles', async () => {
    app = Fastify();
    app.register(debugCoherenceRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?min_articles=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('over-fetches from prisma to compensate for JS filtering', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    // limit=50 → fetchLimit = Math.max(50*10, 500) = 500
    await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary?limit=50' });
    expect(prisma.eventVersion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });

  it('does not crash when versions lack coherence_gate in packet_json', async () => {
    const prisma = makePrisma([
      // Version without coherence_gate
      { eventId: 'evt-no-cg', createdAt: new Date(), headline: 'No gate', packetJson: { some_other_field: true } },
      // Version with null packetJson
      { eventId: 'evt-null', createdAt: new Date(), headline: null, packetJson: null },
      // Version with coherence_gate
      makeVersion('evt-ok', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    // Only the one with coherence_gate should appear
    expect(body.total_events).toBe(1);
    expect(body.pass_count).toBe(1);
  });

  it('percentiles exclude NA rows', async () => {
    const prisma = makePrisma([
      // NA row with title_jaccard = 0.9 — should NOT contribute to percentiles
      makeVersion('evt-na', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: 0.9, stddev_drift: null, article_count: 1 }),
      // PASS row with low title_jaccard
      makeVersion('evt-pass', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    // NA row counts for na_count but not percentiles
    expect(body.na_count).toBe(1);
    expect(body.pass_count).toBe(1);

    // title_jaccard percentiles should only reflect the PASS row (0.2), not NA (0.9)
    expect(body.percentiles.title_jaccard.p50).toBeCloseTo(0.2, 5);
    // avg_cosine should only have the PASS row
    expect(body.percentiles.avg_cosine.p50).toBeCloseTo(0.7, 5);
  });
});

describe('debug-coherence routes — sample', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns deterministic response shape', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 3 }, ['low_embedding_cohesion', 'low_entity_overlap'], 'Test headline'),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=FAIL&min_articles=2' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('total');
    expect(body).toHaveProperty('filters');
    expect(body.filters).toEqual({ status: 'FAIL', min_articles: 2, limit: 50 });
    expect(body).toHaveProperty('rows');
    expect(body.rows).toHaveLength(1);

    const row = body.rows[0];
    expect(row).toHaveProperty('event_id', 'evt-1');
    expect(row).toHaveProperty('created_at');
    expect(row).toHaveProperty('headline', 'Test headline');
    expect(row).toHaveProperty('status', 'FAIL');
    expect(row).toHaveProperty('failed_checks');
    expect(row).toHaveProperty('metrics');
    expect(row.metrics).toHaveProperty('avg_cosine');
    expect(row.metrics).toHaveProperty('entity_jaccard');
    expect(row.metrics).toHaveProperty('title_jaccard');
    expect(row.metrics).toHaveProperty('stddev_drift');
    expect(row.metrics).toHaveProperty('article_count', 3);
    expect(row).toHaveProperty('thresholds');
    expect(row.thresholds).toHaveProperty('min_avg_cosine');
  });

  it('filters by status', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 3 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-3', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: null, stddev_drift: null, article_count: 1 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const resFail = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=FAIL' });
    expect(resFail.json().total).toBe(1);
    expect(resFail.json().rows[0].event_id).toBe('evt-2');

    const resNA = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=NA' });
    expect(resNA.json().total).toBe(1);
    expect(resNA.json().rows[0].event_id).toBe('evt-3');
  });

  it('filters by min_articles', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: null, stddev_drift: null, article_count: 1 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?min_articles=2' });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.rows[0].event_id).toBe('evt-1');
  });

  it('combines status + min_articles filters', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 4 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.4, entity_jaccard: 0.03, title_jaccard: 0.05, stddev_drift: 0.4, article_count: 1 }, ['low_embedding_cohesion', 'title_content_mismatch']),
      makeVersion('evt-3', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=FAIL&min_articles=2' });
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.rows[0].event_id).toBe('evt-1');
  });

  it('returns empty rows when no matches', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=FAIL' });
    const body = res.json();
    expect(body.total).toBe(0);
    expect(body.rows).toEqual([]);
  });

  it('rejects invalid status', async () => {
    app = Fastify();
    app.register(debugCoherenceRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?status=INVALID' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects invalid limit', async () => {
    app = Fastify();
    app.register(debugCoherenceRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample?limit=0' });
    expect(res.statusCode).toBe(400);
  });
});
