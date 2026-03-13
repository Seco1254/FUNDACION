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
    topicAssignments: [],
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

function makeRepoReturning(rows: any[], stateCounts: Record<string, number> = {}) {
  return {
    getFeed: async () => rows,
    countEventsByState: async () => stateCounts,
  } as unknown as FeedRepository;
}

describe('buildFeedFallbackOverview', () => {
  it('returns headline + sources + pending status label', () => {
    const result = buildFeedFallbackOverview(
      'Reforma tributaria aprobada',
      [
        { media_key: 'eltiempo', name: 'El Tiempo' },
        { media_key: 'elespectador', name: 'El Espectador' },
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
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      const item = feed.items[0];
      expect(item.event_id).toBe('evt-1');
      expect(item.overview.status).toBe('pending');
      // Fallback overview should be populated
      expect(item.overview.what_happened).toContain('Test headline');
      expect(item.overview.confidence_label).toBe('Pendiente');
    });

    it('event with overview unavailable appears in feed with fallback overview', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline',
          packetJson: {
            ai_overview: { what_happened: [], context: [], in_dispute: [] },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      const item = feed.items[0];
      expect(item.overview.status).toBe('unavailable');
      expect(item.overview.what_happened).toContain('Evidencia en proceso de verificación.');
    });

    it('event with overview ready appears with real overview (no fallback)', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline ready',
          packetJson: {
            ai_overview: {
              what_happened: ['La reforma tributaria fue aprobada en segundo debate por el Congreso.'],
              context: ['El trámite legislativo se completó tras semanas de discusión política.'],
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
      expect(item.overview.status).toBe('ready');
      expect(item.overview.what_happened).toEqual(['La reforma tributaria fue aprobada en segundo debate por el Congreso.']);
      expect(item.overview.confidence_label).toBe('Alta');
    });

    it('always includes sources[], evidence_level for pending items', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];

      expect(item.sources).toHaveLength(2);
      expect(item.sources[0].name).toBe('El Tiempo');
      expect(item.sources[1].name).toBe('El Espectador');
      expect(item.evidence_level).toBeDefined();
      expect(item.source_count).toBe(2);
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

  describe('topic extraction', () => {
    it('extracts topic from topicAssignments', async () => {
      const row = makeMockRow({
        topicAssignments: [{ topicKey: 'ECONOMIA', weight: 0.8 }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items[0].topic).toEqual({ key: 'ECONOMIA', label: 'Economía' });
    });

    it('falls back to packetJson topics when topicAssignments empty', async () => {
      const row = makeMockRow({
        topicAssignments: [],
        versions: [{
          id: 'ver-1',
          headline: 'Test',
          packetJson: {
            topics: { top_topics: [{ key: 'SALUD', weight: 0.6 }] },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items[0].topic).toEqual({ key: 'SALUD', label: 'Salud' });
    });

    it('returns null topic when no assignment exists', async () => {
      const row = makeMockRow({ topicAssignments: [] });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items[0].topic).toBeNull();
    });
  });

  describe('race condition: overview pending → ready', () => {
    it('same event transitions from pending to ready across feed calls', async () => {
      const rowPending = makeMockRow();
      let currentRows = [rowPending];
      const repo = {
        getFeed: async () => currentRows,
      } as unknown as FeedRepository;
      const service = new FeedService(repo);

      const feed1 = await service.getFeed();
      expect(feed1.items).toHaveLength(1);
      expect(feed1.items[0].overview.status).toBe('pending');
      expect(feed1.items[0].overview.confidence_label).toBe('Pendiente');

      const rowReady = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Test headline',
          packetJson: {
            ai_overview: {
              what_happened: ['La reforma tributaria fue aprobada en segundo debate por el Congreso colombiano.'],
              context: ['El trámite legislativo se completó tras semanas de negociación política.'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      currentRows = [rowReady];

      const feed2 = await service.getFeed();
      expect(feed2.items).toHaveLength(1);
      expect(feed2.items[0].event_id).toBe('evt-1');
      expect(feed2.items[0].overview.status).toBe('ready');
      expect(feed2.items[0].overview.what_happened).toEqual(['La reforma tributaria fue aprobada en segundo debate por el Congreso colombiano.']);
      expect(feed2.items[0].overview.confidence_label).toBe('Alta');
    });
  });

  describe('gate filtering', () => {
    it('event with no articles is filtered out by gate', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Failed',
          packetJson: {
            ai_overview: { what_happened: ['x'], context: ['y'], in_dispute: [] },
          },
        }],
        eventArticles: [],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items).toHaveLength(0);
    });

    it('returns empty feed with empty_reason when no published events', async () => {
      const repo = makeRepoReturning([], { DETECTED: 3, PENDING_PUBLISH: 1 });
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.next_cursor).toBeNull();
      expect(feed.meta.empty_reason).toBe('no_published');
    });

    it('returns no_events when no events at all', async () => {
      const repo = makeRepoReturning([], {});
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.meta.empty_reason).toBe('no_events');
    });

    it('returns no_events when all published events are gated', async () => {
      const row = makeMockRow({ eventArticles: [] });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.meta.empty_reason).toBe('no_events');
    });
  });

  describe('legacy data cleanup (P0.2)', () => {
    it('caps what_happened to 5 bullets from legacy data with 40+ bullets', () => {
      const legacyBullets = Array.from({ length: 40 }, (_, i) =>
        `Este es el bullet número ${i + 1} sobre la reforma tributaria.`,
      );
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Reforma tributaria',
          packetJson: {
            ai_overview: {
              what_happened: legacyBullets,
              context: ['Contexto relevante sobre el trámite legislativo actual.'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      return service.getFeed().then((feed) => {
        expect(feed.items).toHaveLength(1);
        expect(feed.items[0].overview.what_happened.length).toBeLessThanOrEqual(5);
        expect(feed.items[0].overview.context.length).toBeLessThanOrEqual(3);
      });
    });

    it('filters noisy/short bullets from legacy data', () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Evento legacy',
          packetJson: {
            ai_overview: {
              what_happened: [
                'La reforma fue aprobada en segundo debate por el Congreso colombiano.',
                'xy',  // too short (< 30 chars)
                'https://example.com/image.jpg',  // noise: bare URL
                'Lea también noticias sobre economía en nuestra sección especial.',  // noise: navigation
                'El presidente anunció cambios en política de seguridad nacional.',
              ],
              context: ['Compartir en redes sociales este contenido importante.'],  // noise: action button pattern
              in_dispute: [],
              confidence_label: 'Media',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      return service.getFeed().then((feed) => {
        const ov = feed.items[0].overview;
        expect(ov.what_happened).toEqual([
          'La reforma fue aprobada en segundo debate por el Congreso colombiano.',
          'El presidente anunció cambios en política de seguridad nacional.',
        ]);
        expect(ov.context).toEqual([]); // noise bullet filtered out
      });
    });

    it('truncates overly long legacy bullets to 500 chars', () => {
      const longBullet = 'A'.repeat(600);
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Evento largo',
          packetJson: {
            ai_overview: {
              what_happened: [longBullet],
              context: [],
              in_dispute: [],
              confidence_label: 'Baja',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      return service.getFeed().then((feed) => {
        const wh = feed.items[0].overview.what_happened;
        expect(wh).toHaveLength(1);
        expect(wh[0].length).toBeLessThanOrEqual(500);
        expect(wh[0].endsWith('…')).toBe(true);
      });
    });
  });

  describe('response shape (FeedCard contract)', () => {
    it('uses updated_at instead of t_last', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];
      expect(item.updated_at).toBe('2026-02-20T10:00:00.000Z');
      expect((item as any).t_last).toBeUndefined();
    });

    it('uses overview instead of ai_overview', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];
      expect(item.overview).toBeDefined();
      expect(item.overview.status).toBeDefined();
      expect((item as any).ai_overview).toBeUndefined();
      expect((item as any).overview_status).toBeUndefined();
    });

    it('does not expose internal fields', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0] as any;
      expect(item.state).toBeUndefined();
      expect(item.unique_sources_count).toBeUndefined();
      expect(item.usable_articles_count).toBeUndefined();
      expect(item.total_usable_text_len).toBeUndefined();
      expect(item.key_facts_count).toBeUndefined();
      expect(item.overview_mode).toBeUndefined();
      expect(item.why_no_overview).toBeUndefined();
    });

    it('has meta with has_more', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.meta).toBeDefined();
      expect(feed.meta.has_more).toBe(false);
    });

    it('sources use media_key instead of source_id', async () => {
      const row = makeMockRow();
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const source = feed.items[0].sources[0];
      expect(source.media_key).toBe('eltiempo');
      expect(source.name).toBe('El Tiempo');
      expect((source as any).source_id).toBeUndefined();
      expect((source as any).domain).toBeUndefined();
    });
  });
});
