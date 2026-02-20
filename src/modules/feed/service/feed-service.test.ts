import { describe, it, expect } from 'vitest';
import { FeedService, buildFeedFallbackOverview } from './feed-service.js';
import { FeedRepository } from '../repo/feed-repo.js';

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

function makeRepoReturning(rows: any[]) {
  return {
    getFeed: async () => rows,
  } as unknown as FeedRepository;
}

describe('buildFeedFallbackOverview', () => {
  it('returns headline + sources + pending status label', () => {
    const result = buildFeedFallbackOverview(
      'Reforma tributaria aprobada',
      [
        { source_id: 'm1', name: 'El Tiempo', domain: 'eltiempo.com', article_count: 1 },
        { source_id: 'm2', name: 'El Espectador', domain: 'elespectador.com', article_count: 1 },
      ],
      'pending',
    );
    expect(result.what_happened).toContain('Reforma tributaria aprobada');
    expect(result.what_happened).toContain('Fuentes: El Tiempo, El Espectador.');
    expect(result.what_happened).toContain('Resumen en proceso.');
    expect(result.confidence_label).toBe('Pendiente');
    expect(result.context).toEqual([]);
    expect(result.in_dispute).toEqual([]);
  });

  it('uses unavailable label when overview is unavailable', () => {
    const result = buildFeedFallbackOverview('Headline', [], 'unavailable');
    expect(result.what_happened).toContain('Evidencia en proceso de verificación.');
  });

  it('handles null headline gracefully', () => {
    const result = buildFeedFallbackOverview(null, [], 'pending');
    expect(result.what_happened).toHaveLength(1); // just the status label
    expect(result.what_happened[0]).toBe('Resumen en proceso.');
  });
});

describe('FeedService', () => {
  describe('controlled degradation', () => {
    it('event with overview pending appears in feed with fallback overview', async () => {
      // Row with no ai_overview in packet → overview_status = 'pending'
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      const item = feed.items[0];
      expect(item.event_id).toBe('evt-1');
      expect(item.overview_status).toBe('pending');
      expect(item.why_no_overview).not.toBeNull();
      expect(item.why_no_overview).toContain('status=pending');
      // Fallback overview should be populated
      expect(item.ai_overview).not.toBeNull();
      expect(item.ai_overview!.what_happened).toContain('Test headline');
      expect(item.ai_overview!.confidence_label).toBe('Pendiente');
    });

    it('event with overview unavailable appears in feed with fallback overview', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline',
          packetJson: {
            ai_overview: { what_happened: [], context: [], in_dispute: [] }, // empty → unavailable
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      const item = feed.items[0];
      expect(item.overview_status).toBe('unavailable');
      expect(item.ai_overview).not.toBeNull();
      expect(item.ai_overview!.what_happened).toContain('Evidencia en proceso de verificación.');
    });

    it('event with overview ready appears with real overview (no fallback)', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline ready',
          packetJson: {
            ai_overview: {
              what_happened: ['La reforma fue aprobada.'],
              context: ['Contexto político.'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      const item = feed.items[0];
      expect(item.overview_status).toBe('ready');
      expect(item.ai_overview!.what_happened).toEqual(['La reforma fue aprobada.']);
      expect(item.ai_overview!.confidence_label).toBe('Alta');
      expect(item.why_no_overview).toBeNull();
    });

    it('always includes sources[], evidence_level, why_no_overview for pending items', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];

      expect(item.sources).toHaveLength(2);
      expect(item.sources![0].name).toBe('El Tiempo');
      expect(item.sources![1].name).toBe('El Espectador');
      expect(item.evidence_level).toBeDefined();
      expect(item.unique_sources_count).toBe(2);
      expect(item.article_count).toBe(2);
    });

    it('published_at is never null for PUBLISHED events', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items[0].published_at).not.toBeNull();
    });
  });

  describe('race condition: overview pending → ready', () => {
    it('same event transitions from pending to ready across feed calls', async () => {
      // Call 1: overview pending
      const rowPending = makeMockRow();
      let currentRows = [rowPending];
      const repo = {
        getFeed: async () => currentRows,
      } as unknown as FeedRepository;
      const service = new FeedService(repo);

      const feed1 = await service.getFeed();
      expect(feed1.items).toHaveLength(1);
      expect(feed1.items[0].overview_status).toBe('pending');
      expect(feed1.items[0].ai_overview).not.toBeNull();
      expect(feed1.items[0].ai_overview!.confidence_label).toBe('Pendiente');

      // Call 2: overview ready (simulate OverviewGenerated writing to packet)
      const rowReady = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Test headline',
          packetJson: {
            ai_overview: {
              what_happened: ['La reforma fue aprobada por el Congreso.'],
              context: ['Trámite legislativo completado.'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      currentRows = [rowReady];

      const feed2 = await service.getFeed();
      expect(feed2.items).toHaveLength(1);
      expect(feed2.items[0].event_id).toBe('evt-1'); // same event
      expect(feed2.items[0].overview_status).toBe('ready');
      expect(feed2.items[0].ai_overview!.what_happened).toEqual(['La reforma fue aprobada por el Congreso.']);
      expect(feed2.items[0].ai_overview!.confidence_label).toBe('Alta');
      expect(feed2.items[0].why_no_overview).toBeNull();
    });
  });

  describe('gate filtering', () => {
    it('event with overview_status failed is filtered out', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Failed',
          packetJson: {
            ai_overview: { what_happened: ['x'], context: ['y'], in_dispute: [] },
            // We can't set overview_status directly; "failed" is set by the gate
          },
        }],
        // No usable text → gate should filter (TEXT_TOO_SHORT)
        eventArticles: [],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      // With no articles → no sources, no text → TEXT_TOO_SHORT + NO_SOURCES → filtered
      expect(feed.items).toHaveLength(0);
    });

    it('returns empty feed when no published events', async () => {
      const repo = makeRepoReturning([]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.next_cursor).toBeNull();
    });
  });
});
