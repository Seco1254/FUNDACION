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

/** Build a version with legacy `details` format (no `metrics` key). */
function makeLegacyVersion(
  eventId: string,
  status: 'PASS' | 'FAIL',
  details: {
    embedding_cohesion: number | null;
    entity_overlap: number | null;
    title_alignment: number | null;
    topic_drift_variance: number | null;
  },
  failedChecks: string[] = [],
) {
  return {
    eventId,
    createdAt: new Date('2026-02-26T09:00:00Z'),
    headline: null,
    packetJson: {
      coherence_gate: {
        status,
        failed_checks: failedChecks,
        details,
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

  it('returns deterministic response shape with bins, observability, warnings', async () => {
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
    // Percentiles with p50, p75, p90, count
    expect(body).toHaveProperty('percentiles');
    expect(body.percentiles.avg_cosine).toHaveProperty('p50');
    expect(body.percentiles.avg_cosine).toHaveProperty('p75');
    expect(body.percentiles.avg_cosine).toHaveProperty('p90');
    expect(body.percentiles.avg_cosine).toHaveProperty('count');
    // Bins
    expect(body).toHaveProperty('bins');
    expect(body.bins).toHaveProperty('1');
    expect(body.bins).toHaveProperty('2');
    expect(body.bins).toHaveProperty('3-4');
    expect(body.bins).toHaveProperty('5-9');
    expect(body.bins).toHaveProperty('10+');
    // Observability
    expect(body).toHaveProperty('observability');
    expect(body.observability).toHaveProperty('legacy_rows');
    expect(body.observability).toHaveProperty('total_rows');
    expect(body.observability).toHaveProperty('legacy_pct');
    // Warnings
    expect(body).toHaveProperty('warnings');
    expect(Array.isArray(body.warnings)).toBe(true);
    // Fail reasons
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

  it('bins article_count into correct groups', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: null, stddev_drift: null, article_count: 1 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.1, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-3', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.03, article_count: 2 }),
      makeVersion('evt-4', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 5 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-5', 'PASS', { avg_cosine: 0.9, entity_jaccard: 0.3, title_jaccard: 0.4, stddev_drift: 0.02, article_count: 12 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    // NA article_count=1 → bin '1'
    expect(body.bins['1'].na).toBe(1);
    // Two PASS article_count=2 → bin '2'
    expect(body.bins['2'].pass).toBe(2);
    expect(body.bins['2'].total).toBe(2);
    // FAIL article_count=5 → bin '5-9'
    expect(body.bins['5-9'].fail).toBe(1);
    // PASS article_count=12 → bin '10+'
    expect(body.bins['10+'].pass).toBe(1);
    // bin '3-4' empty
    expect(body.bins['3-4'].total).toBe(0);
  });

  it('computes fail_rate per bin', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 2 }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    // bin '2': 1 pass + 1 fail → fail_rate = 0.5
    expect(body.bins['2'].fail_rate).toBeCloseTo(0.5, 5);
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
    expect(body.percentiles.avg_cosine).toEqual({ p50: 0, p75: 0, p90: 0, count: 0 });
    expect(body.observability.legacy_rows).toBe(0);
    expect(body.warnings).toEqual([]);
  });

  it('detects legacy (details) format rows', async () => {
    const prisma = makePrisma([
      makeLegacyVersion('evt-legacy', 'PASS', {
        embedding_cohesion: 0.65,
        entity_overlap: 0.10,
        title_alignment: 0.20,
        topic_drift_variance: 0.06,
      }),
      makeVersion('evt-new', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.observability.legacy_rows).toBe(1);
    expect(body.observability.total_rows).toBe(2);
    expect(body.observability.legacy_pct).toBeCloseTo(0.5, 5);
    // Legacy row metrics should still be read correctly
    expect(body.percentiles.avg_cosine.count).toBe(2);
  });

  it('emits warning when global FAIL rate exceeds threshold', async () => {
    // 5 FAIL + 1 PASS = 83% fail rate (above 40% threshold)
    const prisma = makePrisma([
      makeVersion('evt-1', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 2 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 3 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-3', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 4 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-4', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 5 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-5', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 6 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-6', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.warnings.length).toBeGreaterThanOrEqual(1);
    expect(body.warnings[0]).toContain('global FAIL rate');
  });

  it('emits warning when bin-2 FAIL rate exceeds threshold', async () => {
    // 3 FAIL + 1 PASS in bin 2 → 75% fail rate (above 60% threshold)
    const prisma = makePrisma([
      makeVersion('evt-1', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 2 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-2', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 2 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-3', 'FAIL', { avg_cosine: 0.3, entity_jaccard: 0.01, title_jaccard: 0.02, stddev_drift: 0.5, article_count: 2 }, ['low_embedding_cohesion', 'low_entity_overlap']),
      makeVersion('evt-4', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    const bin2Warning = body.warnings.find((w: string) => w.includes('article_count=2'));
    expect(bin2Warning).toBeDefined();
    expect(bin2Warning).toContain('too aggressive for small clusters');
  });

  it('no warnings when rates are healthy', async () => {
    const prisma = makePrisma([
      makeVersion('evt-1', 'PASS', { avg_cosine: 0.8, entity_jaccard: 0.2, title_jaccard: 0.3, stddev_drift: 0.05, article_count: 2 }),
      makeVersion('evt-2', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.08, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.warnings).toEqual([]);
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
      { eventId: 'evt-no-cg', createdAt: new Date(), headline: 'No gate', packetJson: { some_other_field: true } },
      { eventId: 'evt-null', createdAt: new Date(), headline: null, packetJson: null },
      makeVersion('evt-ok', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.total_events).toBe(1);
    expect(body.pass_count).toBe(1);
  });

  it('percentiles exclude NA rows', async () => {
    const prisma = makePrisma([
      makeVersion('evt-na', 'NA', { avg_cosine: null, entity_jaccard: null, title_jaccard: 0.9, stddev_drift: null, article_count: 1 }),
      makeVersion('evt-pass', 'PASS', { avg_cosine: 0.7, entity_jaccard: 0.15, title_jaccard: 0.2, stddev_drift: 0.05, article_count: 3 }),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/summary' });
    const body = res.json();

    expect(body.na_count).toBe(1);
    expect(body.pass_count).toBe(1);
    expect(body.percentiles.title_jaccard.p50).toBeCloseTo(0.2, 5);
    expect(body.percentiles.avg_cosine.p50).toBeCloseTo(0.7, 5);
  });
});

describe('debug-coherence routes — sample', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns deterministic response shape with is_legacy flag', async () => {
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
    expect(row).toHaveProperty('is_legacy', false);
  });

  it('marks legacy-format rows in sample output', async () => {
    const prisma = makePrisma([
      makeLegacyVersion('evt-legacy', 'FAIL', {
        embedding_cohesion: 0.30,
        entity_overlap: 0.01,
        title_alignment: 0.02,
        topic_drift_variance: 0.50,
      }, ['low_embedding_cohesion', 'low_entity_overlap']),
    ]);

    app = Fastify();
    app.register(debugCoherenceRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/coherence/sample' });
    const body = res.json();

    expect(body.rows[0].is_legacy).toBe(true);
    expect(body.rows[0].metrics.avg_cosine).toBeCloseTo(0.30, 5);
    expect(body.rows[0].metrics.entity_jaccard).toBeCloseTo(0.01, 5);
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
