import { describe, it, expect } from 'vitest';
import { FeedService, buildFeedFallbackOverview, buildNarrativeFallback, isInstitutionalEvent } from './feed-service.js';
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
        contentType: 'news',
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
        contentType: 'news',
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

// ── buildNarrativeFallback ──────────────────────────────────────────

describe('buildNarrativeFallback', () => {
  it('builds narrative paragraph from multiple what_happened bullets', () => {
    const wh = [
      'El Congreso aprobó la reforma tributaria tras intensas negociaciones',
      'La oposición criticó varios artículos del proyecto de ley',
      'El presidente señaló que la reforma beneficiará a los más vulnerables del país',
    ];
    const result = buildNarrativeFallback(wh, []);
    expect(result).not.toBeNull();
    expect(result).toContain('El Congreso aprobó');
    expect(result).toContain('Además');
    // Should be a continuous paragraph (no bullet points)
    expect(result).not.toContain('•');
  });

  it('returns null for empty input', () => {
    expect(buildNarrativeFallback([], [])).toBeNull();
  });

  it('returns null for single short sentence', () => {
    expect(buildNarrativeFallback(['Corta.'], [])).toBeNull();
  });

  it('includes context sentences when available', () => {
    const wh = ['La reforma fue aprobada por el Congreso colombiano'];
    const ctx = ['El trámite legislativo completó su último debate en la plenaria del Senado'];
    const result = buildNarrativeFallback(wh, ctx);
    expect(result).not.toBeNull();
    expect(result).toContain('reforma');
    expect(result).toContain('trámite');
  });

  it('produces a paragraph without bullet markers', () => {
    const wh = [
      'El gobierno anunció nuevas medidas económicas para enfrentar la crisis',
      'Los expertos señalaron que las medidas podrían tener un impacto positivo en la economía',
      'La oposición manifestó sus reservas sobre la efectividad de las propuestas presentadas',
    ];
    const result = buildNarrativeFallback(wh, []);
    expect(result).not.toBeNull();
    expect(result!.startsWith('•')).toBe(false);
    expect(result!.includes('\n•')).toBe(false);
  });
});

// ── isInstitutionalEvent ────────────────────────────────────────────

describe('isInstitutionalEvent', () => {
  it('event with single "Quiénes somos" article => excluded', () => {
    const row = {
      eventArticles: [{
        article: {
          id: 'a1',
          contentType: 'institutional_static',
          url: 'https://razonpublica.com/quienes-somos/',
        },
      }],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('ALL_INSTITUTIONAL_STATIC');
  });

  it('event with news + institutional_static => NOT excluded', () => {
    const row = {
      eventArticles: [
        { article: { id: 'a1', contentType: 'news' } },
        { article: { id: 'a2', contentType: 'institutional_static' } },
      ],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(false);
  });

  it('event with all institutional (convocatorias) and no news => excluded', () => {
    const row = {
      eventArticles: [
        { article: { id: 'a1', contentType: 'institutional' } },
        { article: { id: 'a2', contentType: 'institutional' } },
      ],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('ALL_INSTITUTIONAL');
  });

  it('event with institutional_static dominant (>= 70%) and no news => excluded', () => {
    const row = {
      eventArticles: [
        { article: { id: 'a1', contentType: 'institutional_static' } },
        { article: { id: 'a2', contentType: 'institutional_static' } },
        { article: { id: 'a3', contentType: 'unknown' } },
      ],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(true);
  });

  it('event with only news articles => NOT excluded', () => {
    const row = {
      eventArticles: [
        { article: { id: 'a1', contentType: 'news' } },
        { article: { id: 'a2', contentType: 'news' } },
      ],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(false);
  });

  it('empty eventArticles => NOT excluded', () => {
    const row = { eventArticles: [] };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(false);
  });

  it('mix of institutional_static + institutional + no news => excluded', () => {
    const row = {
      eventArticles: [
        { article: { id: 'a1', contentType: 'institutional_static' } },
        { article: { id: 'a2', contentType: 'institutional' } },
      ],
    };
    const result = isInstitutionalEvent(row);
    expect(result.excluded).toBe(true);
    expect(result.reason).toBe('ALL_INSTITUTIONAL');
  });
});

// ── FeedService integration ─────────────────────────────────────────

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

  describe('overview paragraph fallback', () => {
    it('generates narrative paragraph when overview field is missing but bullets exist', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline',
          packetJson: {
            ai_overview: {
              overview: '', // empty overview
              what_happened: [
                'El Congreso aprobó la reforma tributaria tras intensas negociaciones',
                'La oposición criticó varios artículos del proyecto de ley presentado',
                'El presidente señaló que la reforma beneficiará a los más vulnerables del país',
              ],
              context: ['El trámite legislativo completó su último debate en plenaria'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];

      expect(item.ai_overview).not.toBeNull();
      // The fallback should have generated a narrative paragraph
      expect(item.ai_overview!.overview).toBeDefined();
      expect(typeof item.ai_overview!.overview).toBe('string');
      expect(item.ai_overview!.overview!.length).toBeGreaterThan(0);
      // Should not contain bullet markers
      expect(item.ai_overview!.overview).not.toContain('•');
    });

    it('preserves existing overview paragraph when present', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Headline',
          packetJson: {
            ai_overview: {
              overview: 'Este es el párrafo narrativo original generado por el LLM que describe los eventos principales de la reforma tributaria.',
              what_happened: ['La reforma fue aprobada.'],
              context: ['Contexto.'],
              in_dispute: [],
              confidence_label: 'Alta',
            },
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      const item = feed.items[0];

      expect(item.ai_overview!.overview).toBe('Este es el párrafo narrativo original generado por el LLM que describe los eventos principales de la reforma tributaria.');
    });
  });

  describe('institutional event filtering', () => {
    it('event with only institutional_static article is filtered from feed', async () => {
      const row = makeMockRow({
        eventArticles: [{
          article: {
            id: 'art-1',
            url: 'https://razonpublica.com/quienes-somos/',
            media: { id: 'media-1', mediaKey: 'razonpublica', name: 'Razón Pública' },
            textContentLen: 1500,
            textContentSource: 'body',
            extractionFailReason: null,
            paywallDetected: false,
            usableForOverview: true,
            contentType: 'institutional_static',
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items).toHaveLength(0);
    });

    it('event with news + institutional_static articles appears in feed', async () => {
      const row = makeMockRow({
        eventArticles: [
          {
            article: {
              id: 'art-1',
              url: 'https://eltiempo.com/noticia',
              media: { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo' },
              textContentLen: 1500,
              textContentSource: 'body',
              extractionFailReason: null,
              paywallDetected: false,
              usableForOverview: true,
              contentType: 'news',
            },
          },
          {
            article: {
              id: 'art-2',
              url: 'https://razonpublica.com/quienes-somos/',
              media: { id: 'media-2', mediaKey: 'razonpublica', name: 'Razón Pública' },
              textContentLen: 800,
              textContentSource: 'body',
              extractionFailReason: null,
              paywallDetected: false,
              usableForOverview: true,
              contentType: 'institutional_static',
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].event_id).toBe('evt-1');
    });

    it('event with all institutional (convocatoria) articles is filtered from feed', async () => {
      const row = makeMockRow({
        eventArticles: [
          {
            article: {
              id: 'art-1',
              url: 'https://example.com/convocatoria',
              media: { id: 'media-1', mediaKey: 'example', name: 'Example' },
              textContentLen: 1500,
              textContentSource: 'body',
              extractionFailReason: null,
              paywallDetected: false,
              usableForOverview: true,
              contentType: 'institutional',
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();
      expect(feed.items).toHaveLength(0);
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

    it('returns empty feed with empty_reason when no published events', async () => {
      const repo = makeRepoReturning([], { DETECTED: 3, PENDING_PUBLISH: 1 });
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.next_cursor).toBeNull();
      expect(feed.empty_reason).toBe('NO_PUBLISHED');
    });

    it('returns DB_EMPTY when no events at all', async () => {
      const repo = makeRepoReturning([], {});
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.empty_reason).toBe('DB_EMPTY');
    });

    it('returns GATE_FILTERED_ALL when all published events are gated', async () => {
      // Row with no articles → filtered by gate
      const row = makeMockRow({ eventArticles: [] });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items).toEqual([]);
      expect(feed.empty_reason).toBe('GATE_FILTERED_ALL');
    });
  });

  describe('topic classification on feed items', () => {
    it('populates topic_key on feed items based on headline', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Gobierno anuncia reforma tributaria en Colombia',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].topic_key).toBe('POLITICA');
    });

    it('classifies sports headline as DEPORTES', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Colombia goleó 3-0 a Perú en eliminatoria mundialista',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].topic_key).toBe('DEPORTES');
    });

    it('classifies crime headline as CRIMEN_SEGURIDAD', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Capturan a narcotraficante en operativo de la fiscalía',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].topic_key).toBe('CRIMEN_SEGURIDAD');
    });

    it('populates OTROS for non-classifiable headline', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Bonito día de sol en la ciudad',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].topic_key).toBe('OTROS');
    });
  });

  describe('importance score on feed items', () => {
    it('populates importance_score on feed items', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Gobierno anuncia reforma',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(typeof feed.items[0].importance_score).toBe('number');
      expect(feed.items[0].importance_score).toBeGreaterThan(0);
      expect(feed.items[0].importance_score).toBeLessThanOrEqual(1);
    });

    it('importance_score reflects topic weight (POLITICA > OTROS)', async () => {
      // POLITICA event
      const rowPol = makeMockRow({
        id: 'evt-pol',
        versions: [{
          id: 'ver-1',
          headline: 'Gobierno anuncia nueva reforma',
          packetJson: {},
        }],
      });
      // OTROS event (same text length, same publishedAt)
      const rowOtros = makeMockRow({
        id: 'evt-otros',
        versions: [{
          id: 'ver-2',
          headline: 'Bonito día de sol en la costa',
          packetJson: {},
        }],
      });

      const repo = makeRepoReturning([rowPol, rowOtros]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();

      const polItem = feed.items.find((i) => i.event_id === 'evt-pol');
      const otrosItem = feed.items.find((i) => i.event_id === 'evt-otros');

      expect(polItem).toBeDefined();
      expect(otrosItem).toBeDefined();
      expect(polItem!.importance_score).toBeGreaterThan(otrosItem!.importance_score!);
    });
  });
});
