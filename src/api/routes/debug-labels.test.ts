import { describe, it, expect, afterEach } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugLabelsRoutes } from './debug-labels.js';

// ── Minimal Prisma mock ──────────────────────────────────────────

function makeMockPrisma(overrides: Record<string, any> = {}) {
  const store: any[] = overrides.store ?? [];
  return {
    eventLabel: {
      findMany: async (opts: any) => {
        let result = [...store];
        if (opts?.where?.label) {
          result = result.filter((r: any) => r.label === opts.where.label);
        }
        if (opts?.orderBy?.createdAt === 'desc') {
          result.sort((a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime());
        }
        if (opts?.take) result = result.slice(0, opts.take);
        return result;
      },
      create: async (opts: any) => {
        const row = {
          id: 'new-uuid',
          eventId: opts.data.eventId,
          label: opts.data.label,
          note: opts.data.note,
          gitSha: opts.data.gitSha ?? null,
          snapshotJson: opts.data.snapshotJson ?? {},
          createdAt: new Date(),
        };
        store.push(row);
        return row;
      },
      groupBy: async () => overrides.groupByResult ?? [],
    },
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────

describe('debug-labels routes', () => {
  let app: FastifyInstance;

  afterEach(async () => { await app?.close(); });

  // ── GET /v1/debug/labels ──

  it('GET returns empty list when no labels exist', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/labels' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(0);
    expect(body.labels).toEqual([]);
  });

  it('GET returns labels when they exist', async () => {
    const store = [
      { id: 'l-1', eventId: 'e-1', label: 'GOOD', note: null, gitSha: 'abc', snapshotJson: { title: 'x' }, createdAt: new Date() },
    ];
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma({ store })));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/labels' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.count).toBe(1);
    expect(body.labels[0].label).toBe('GOOD');
    expect(body.labels[0].has_snapshot).toBe(true);
  });

  it('GET filters by label param', async () => {
    const store = [
      { id: 'l-1', eventId: 'e-1', label: 'GOOD', note: null, gitSha: null, snapshotJson: {}, createdAt: new Date() },
      { id: 'l-2', eventId: 'e-2', label: 'BAD_MERGE', note: null, gitSha: null, snapshotJson: {}, createdAt: new Date() },
    ];
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma({ store })));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/labels?label=BAD_MERGE' });
    expect(res.statusCode).toBe(200);
    expect(res.json().labels).toHaveLength(1);
    expect(res.json().labels[0].label).toBe('BAD_MERGE');
  });

  it('GET rejects invalid label filter', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/labels?label=INVALID' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid label');
  });

  // ── POST /v1/debug/labels ──

  it('POST creates a label successfully', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: { event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd', label: 'GOOD' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.label).toBe('GOOD');
    expect(body.event_id).toBe('12345678-aaaa-bbbb-cccc-dddddddddddd');
  });

  it('POST rejects missing event_id', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: { label: 'GOOD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('event_id');
  });

  it('POST rejects invalid label', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: { event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd', label: 'FAKE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid label');
  });

  it('POST rejects BAD_OTHER without note', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: { event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd', label: 'BAD_OTHER' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('BAD_OTHER');
  });

  it('POST accepts BAD_OTHER with note', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: {
        event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd',
        label: 'BAD_OTHER',
        note: 'duplicate event from different region',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe('BAD_OTHER');
    expect(res.json().note).toBe('duplicate event from different region');
  });

  it('POST is case-insensitive for label', async () => {
    app = Fastify();
    app.register(debugLabelsRoutes(makeMockPrisma()));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/debug/labels',
      payload: { event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd', label: 'good' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().label).toBe('GOOD');
  });
});
