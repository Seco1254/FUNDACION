import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugFeedRoutes } from './debug-feed.js';
import { FeedRepository } from '../../modules/feed/repo/feed-repo.js';

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

    // Samples
    expect(body.sample_pass).not.toBeNull();
    expect(body.sample_pass.event_id).toBe('evt-pass');
    expect(body.sample_pass.gate_pass).toBe(true);

    expect(body.sample_fail).not.toBeNull();
    expect(body.sample_fail.event_id).toBe('evt-fail');
    expect(body.sample_fail.gate_pass).toBe(false);

    // Events list
    expect(body.events).toHaveLength(2);
    for (const evt of body.events) {
      expect(evt).toHaveProperty('event_id');
      expect(evt).toHaveProperty('overview_status');
      expect(evt).toHaveProperty('gate_pass');
      expect(evt).toHaveProperty('evidence_level');
    }

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
    expect(body.sample_pass).toBeNull();
    expect(body.sample_fail).toBeNull();

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
