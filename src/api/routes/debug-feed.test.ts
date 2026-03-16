import { describe, it, expect } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugFeedRoutes } from './debug-feed.js';
import { FeedRepository } from '../../modules/feed/repo/feed-repo.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

function makeMockRow(overrides: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    state: 'PUBLISHED',
    tLast: new Date('2026-02-20T10:00:00Z'),
    publishedAt: new Date('2026-02-20T09:00:00Z'),
    createdAt: new Date('2026-02-20T08:00:00Z'),
    versions: [{
      id: 'ver-1',
      headline: 'Test headline',
      packetJson: {},
    }],
    eventArticles: [{
      article: {
        id: 'art-1',
        url: 'https://www.eltiempo.com/article-1',
        media: { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo' },
        textContentLen: 1500,
        textContentSource: 'body',
        extractionFailReason: null,
        paywallDetected: false,
        usableForOverview: true,
      },
    }, {
      article: {
        id: 'art-2',
        url: 'https://www.elespectador.com/article-1',
        media: { id: 'media-2', mediaKey: 'elespectador', name: 'El Espectador' },
        textContentLen: 1200,
        textContentSource: 'body',
        extractionFailReason: null,
        paywallDetected: false,
        usableForOverview: true,
      },
    }],
    ...overrides,
  };
}

describe('GET /v1/debug/feed/stats', () => {
  let app: FastifyInstance;

  it('returns totals, top_filter_reasons, and event list', async () => {
    const passingRow = makeMockRow({ id: 'evt-pass' });
    const failingRow = makeMockRow({
      id: 'evt-fail',
      eventArticles: [], // no articles → no sources, no text → filtered
    });

    const feedRepo = {
      getFeed: async () => [passingRow, failingRow],
    } as unknown as FeedRepository;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/stats' });
    expect(res.statusCode).toBe(200);

    const body = res.json();

    // Totals
    expect(body.totals.published_total).toBe(2);
    expect(body.totals.feed_returned_count).toBe(1);
    expect(body.totals.gate_filtered_count).toBe(1);

    // Top filter reasons
    expect(body.top_filter_reasons.length).toBeGreaterThan(0);
    expect(body.top_filter_reasons[0]).toHaveProperty('reason');
    expect(body.top_filter_reasons[0]).toHaveProperty('count');

    // Gate fail examples
    expect(body.gate_fail_examples).toHaveLength(1);
    expect(body.gate_fail_examples[0].event_id).toBe('evt-fail');

    // Events list
    expect(body.events).toHaveLength(2);
    const pass = body.events.find((e: any) => e.event_id === 'evt-pass');
    const fail = body.events.find((e: any) => e.event_id === 'evt-fail');
    expect(pass.gate_pass).toBe(true);
    expect(fail.gate_pass).toBe(false);

    for (const evt of body.events) {
      expect(evt).toHaveProperty('event_id');
      expect(evt).toHaveProperty('overview_status');
      expect(evt).toHaveProperty('gate_pass');
      expect(evt).toHaveProperty('evidence_level');
    }

    // pipeline is null when no repos provided
    expect(body.pipeline).toBeNull();

    await app.close();
  });

  it('returns empty stats when no published events', async () => {
    const feedRepo = {
      getFeed: async () => [],
    } as unknown as FeedRepository;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/stats' });
    const body = res.json();

    expect(body.totals.published_total).toBe(0);
    expect(body.totals.feed_returned_count).toBe(0);
    expect(body.totals.gate_filtered_count).toBe(0);
    expect(body.events).toHaveLength(0);
    expect(body.gate_fail_examples).toHaveLength(0);

    await app.close();
  });

  it('returns pipeline stats when eventRepo and articleRepo provided', async () => {
    const passingRow = makeMockRow({ id: 'evt-pass' });
    const feedRepo = {
      getFeed: async () => [passingRow],
    } as unknown as FeedRepository;

    const eventRepo = {
      countByState: async () => ({ PUBLISHED: 1 }),
      oldestPendingPublishAt: async () => null,
      findAllWithDetails: async () => [],
    } as unknown as EventRepository;

    const articleRepo = {
      countSince: async () => ({ total: 5, byStatus: { POLICY_OK: 3, POLICY_BLOCKED: 2 } }),
    } as any;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo, eventRepo, articleRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/stats' });
    const body = res.json();

    expect(body.pipeline).not.toBeNull();
    expect(body.pipeline.events_by_state).toHaveProperty('PUBLISHED', 1);

    await app.close();
  });

  it('events include overview_status and why_no_overview for pending items', async () => {
    const row = makeMockRow({ id: 'evt-pending' }); // no ai_overview → pending
    const feedRepo = {
      getFeed: async () => [row],
    } as unknown as FeedRepository;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/stats' });
    const body = res.json();

    const evt = body.events[0];
    expect(evt.overview_status).toBe('pending');
    expect(evt.gate_pass).toBe(true);
    expect(evt.why_no_overview).toContain('status=pending');
    expect(evt.published_at).not.toBeNull();

    await app.close();
  });
});

describe('GET /v1/debug/feed/eligibility', () => {
  let app: FastifyInstance;

  it('returns summary and per-event diagnostics', async () => {
    const feedRepo = { getFeed: async () => [] } as unknown as FeedRepository;

    const publishedRow = {
      id: 'evt-pub',
      state: 'PUBLISHED',
      publishAt: new Date('2026-02-20T08:05:00Z'),
      publishedAt: new Date('2026-02-20T09:00:00Z'),
      createdAt: new Date('2026-02-20T08:00:00Z'),
      versions: [{
        headline: 'Test headline',
        packetJson: { ai_overview: { what_happened: ['Something happened'], context: ['Context'] } },
      }],
      eventArticles: [{
        article: {
          id: 'art-1',
          url: 'https://example.com/a1',
          media: { mediaKey: 'eltiempo', name: 'El Tiempo' },
          textContentLen: 2000,
          textContentSource: 'body',
          extractionFailReason: null,
          paywallDetected: false,
          usableForOverview: true,
        },
      }, {
        article: {
          id: 'art-2',
          url: 'https://example.com/a2',
          media: { mediaKey: 'elespectador', name: 'El Espectador' },
          textContentLen: 1500,
          textContentSource: 'body',
          extractionFailReason: null,
          paywallDetected: false,
          usableForOverview: true,
        },
      }],
    };

    const pendingRow = {
      id: 'evt-pend',
      state: 'PENDING_PUBLISH',
      publishAt: new Date('2099-01-01T00:00:00Z'), // far future → NOT_DUE
      publishedAt: null,
      createdAt: new Date('2026-02-20T08:00:00Z'),
      versions: [],
      eventArticles: [],
    };

    const eventRepo = {
      countByState: async () => ({ PUBLISHED: 1, PENDING_PUBLISH: 1 }),
      oldestPendingPublishAt: async () => null,
      findAllWithDetails: async () => [publishedRow, pendingRow],
    } as unknown as EventRepository;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo, eventRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/eligibility' });
    expect(res.statusCode).toBe(200);

    const body = res.json();

    // Summary
    expect(body.summary.total_events).toBe(2);
    expect(body.summary.by_state).toHaveProperty('PUBLISHED', 1);
    expect(body.summary.by_state).toHaveProperty('PENDING_PUBLISH', 1);

    // Published event should be eligible (2 sources, 3500 text)
    const pub = body.events.find((e: any) => e.event_id === 'evt-pub');
    expect(pub.gate_eligible).toBe(true);
    expect(pub.evidence_level).toBe('medium'); // 2 sources + 3500 text = medium
    expect(pub.unique_sources_count).toBe(2);
    expect(pub.total_usable_text_len).toBe(3500);
    expect(pub.articles).toHaveLength(2);
    expect(pub.dominant_block_cause).toBeNull();

    // Pending event → NOT_DUE
    const pend = body.events.find((e: any) => e.event_id === 'evt-pend');
    expect(pend.state).toBe('PENDING_PUBLISH');
    expect(pend.dominant_block_cause).toBe('NOT_DUE');
    expect(pend.publish_due).toBe(false);

    await app.close();
  });

  it('returns 503 when eventRepo not available', async () => {
    const feedRepo = { getFeed: async () => [] } as unknown as FeedRepository;

    app = Fastify();
    app.register(debugFeedRoutes(feedRepo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/feed/eligibility' });
    expect(res.statusCode).toBe(503);

    await app.close();
  });
});
