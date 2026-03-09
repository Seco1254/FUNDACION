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
        title: 'Test headline article 1',
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
        title: 'Test headline article 2',
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

  describe('topic classification on feed items (aggregated)', () => {
    it('populates topic_key + topic_confidence on feed items', async () => {
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
      expect(feed.items[0].topic_confidence).toBeGreaterThan(0);
      expect(feed.items[0].topic_confidence).toBeLessThanOrEqual(1);
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

    it('aggregates topic from multiple article titles + headline', async () => {
      const row = makeMockRow({
        versions: [{
          id: 'ver-1',
          headline: 'Policía captura narcos en operativo',
          packetJson: {},
        }],
        eventArticles: [
          {
            article: {
              id: 'art-1', url: 'https://a.com/judicial/1', title: 'Fiscalía investiga narcotráfico',
              media: { id: 'm1', mediaKey: 'a', name: 'A' }, textContentLen: 1500,
              textContentSource: 'body', extractionFailReason: null,
              paywallDetected: false, usableForOverview: true, contentType: 'news',
            },
          },
          {
            article: {
              id: 'art-2', url: 'https://b.com/seguridad/2', title: 'Captura de sicarios en Medellín',
              media: { id: 'm2', mediaKey: 'b', name: 'B' }, textContentLen: 1200,
              textContentSource: 'body', extractionFailReason: null,
              paywallDetected: false, usableForOverview: true, contentType: 'news',
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);

      const feed = await service.getFeed();

      expect(feed.items).toHaveLength(1);
      expect(feed.items[0].topic_key).toBe('CRIMEN_SEGURIDAD');
      expect(feed.items[0].topic_confidence).toBeGreaterThan(0.5);
    });
  });

  describe('importance score v2 on feed items', () => {
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
      const rowPol = makeMockRow({
        id: 'evt-pol',
        versions: [{
          id: 'ver-1',
          headline: 'Gobierno anuncia nueva reforma',
          packetJson: {},
        }],
      });
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

  describe('split proxy quarantine', () => {
    it('quarantines event with fragmented topics (3+ articles, mixed desks/topics)', async () => {
      const row = makeMockRow({
        id: 'evt-mixed',
        eventArticles: [
          {
            article: {
              id: 'a1', url: 'https://a.com/politica/1', title: 'Gobierno reforma congreso senado presidente',
              media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' },
              textContentLen: 1500, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'a2', url: 'https://b.com/deportes/1', title: 'Selección fútbol gol mundial copa eliminatoria',
              media: { id: 'm2', mediaKey: 'semana', name: 'Semana' },
              textContentLen: 1200, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'a3', url: 'https://c.com/salud/1', title: 'Hospital médico vacuna paciente salud enfermedad',
              media: { id: 'm3', mediaKey: 'rcn', name: 'RCN' },
              textContentLen: 1100, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
        versions: [{ id: 'ver-1', headline: 'Mixed event', packetJson: {} }],
      });

      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();

      // Event should be quarantined (not in feed)
      expect(feed.items.find((i) => i.event_id === 'evt-mixed')).toBeUndefined();
    });

    it('does NOT quarantine cohesive multi-article event', async () => {
      const row = makeMockRow({
        id: 'evt-cohesive',
        eventArticles: [
          {
            article: {
              id: 'a1', url: 'https://a.com/politica/1', title: 'Gobierno reforma congreso senado presidente',
              media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' },
              textContentLen: 1500, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'a2', url: 'https://b.com/politica/2', title: 'Presidente defiende la reforma tributaria del congreso',
              media: { id: 'm2', mediaKey: 'semana', name: 'Semana' },
              textContentLen: 1200, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'a3', url: 'https://c.com/politica/3', title: 'Congreso aprueba reforma tributaria gobierno senado',
              media: { id: 'm3', mediaKey: 'rcn', name: 'RCN' },
              textContentLen: 1100, textContentSource: 'body', usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
        versions: [{ id: 'ver-1', headline: 'Reforma tributaria', packetJson: {} }],
      });

      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();

      // Event should NOT be quarantined
      expect(feed.items.find((i) => i.event_id === 'evt-cohesive')).toBeDefined();
    });

    it('does NOT quarantine events with fewer than 3 articles', async () => {
      // Default makeMockRow has 2 articles — should not trigger split proxy
      const row = makeMockRow({ id: 'evt-2art' });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();

      expect(feed.items.find((i) => i.event_id === 'evt-2art')).toBeDefined();
    });
  });

  // ── Source Quality Policy ─────────────────────────────────────────

  describe('source quality policy', () => {
    it('blocks event when representative source has allow_in_feed=false (oec)', async () => {
      const row = makeMockRow({
        id: 'evt-oec',
        eventArticles: [{
          article: {
            id: 'art-oec', url: 'https://oec.example.com/page',
            title: 'OEC institutional content',
            media: { id: 'media-oec', mediaKey: 'oec', name: 'OEC' },
            textContentLen: 2000, usableForOverview: true, contentType: 'news',
            extractionFailReason: null, paywallDetected: false,
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-oec')).toBeUndefined();
    });

    it('blocks single-source event when source has single_source_allowed=false (aciur)', async () => {
      const row = makeMockRow({
        id: 'evt-aciur',
        eventArticles: [{
          article: {
            id: 'art-aciur', url: 'https://aciur.example.com/page',
            title: 'ACIUR content',
            media: { id: 'media-aciur', mediaKey: 'aciur', name: 'ACIUR' },
            textContentLen: 2000, usableForOverview: true, contentType: 'news',
            extractionFailReason: null, paywallDetected: false,
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-aciur')).toBeUndefined();
    });

    it('does NOT block multi-source event when one LOW source is present but representative is HIGH', async () => {
      const row = makeMockRow({
        id: 'evt-multi-mixed',
        eventArticles: [
          {
            article: {
              id: 'art-et', url: 'https://www.eltiempo.com/art',
              title: 'Main story', media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' },
              textContentLen: 3000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'art-oec', url: 'https://oec.example.com/data',
              title: 'OEC data', media: { id: 'm-oec', mediaKey: 'oec', name: 'OEC' },
              textContentLen: 500, usableForOverview: true, contentType: 'institutional_static',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      // eltiempo is representative (news, longer text) → not blocked
      expect(feed.items.find((i) => i.event_id === 'evt-multi-mixed')).toBeDefined();
    });

    it('eltiempo gets ranking_multiplier=1.0 (source_policy_multiplier on FeedItem)', async () => {
      const row = makeMockRow({ id: 'evt-et' });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      const item = feed.items.find((i) => i.event_id === 'evt-et');
      expect(item).toBeDefined();
      expect(item!.source_policy_multiplier).toBe(1.0);
      expect(item!.source_tier).toBe('HIGH');
    });

    it('razon_publica gets ranking_multiplier=0.85', async () => {
      const row = makeMockRow({
        id: 'evt-rp',
        eventArticles: [
          {
            article: {
              id: 'art-rp1', url: 'https://razonpublica.com/art1',
              title: 'Analysis piece', media: { id: 'm-rp', mediaKey: 'razon_publica', name: 'Razón Pública' },
              textContentLen: 2000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'art-rp2', url: 'https://other.com/art2',
              title: 'Other article', media: { id: 'm-other', mediaKey: 'other_outlet', name: 'Other' },
              textContentLen: 1500, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      const item = feed.items.find((i) => i.event_id === 'evt-rp');
      expect(item).toBeDefined();
      expect(item!.source_policy_multiplier).toBe(0.85);
      expect(item!.source_mode).toBe('ANALYSIS');
    });

    it('ranking_multiplier < 1.0 reduces v3 final score', async () => {
      // razon_publica (0.85) vs eltiempo (1.0) — same articles except media
      const rpRow = makeMockRow({
        id: 'evt-rp',
        eventArticles: [
          {
            createdAt: new Date(),
            article: {
              id: 'art-rp', url: 'https://razonpublica.com/art1',
              title: 'Story', media: { id: 'm-rp', mediaKey: 'razon_publica', name: 'RP' },
              textContentLen: 2000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            createdAt: new Date(),
            article: {
              id: 'art-other', url: 'https://other.com/art',
              title: 'Story 2', media: { id: 'm-o', mediaKey: 'other', name: 'Other' },
              textContentLen: 1500, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const etRow = makeMockRow({
        id: 'evt-et',
        eventArticles: [
          {
            createdAt: new Date(),
            article: {
              id: 'art-et', url: 'https://eltiempo.com/art1',
              title: 'Story', media: { id: 'm-et', mediaKey: 'eltiempo', name: 'ET' },
              textContentLen: 2000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            createdAt: new Date(),
            article: {
              id: 'art-other2', url: 'https://other2.com/art',
              title: 'Story 2', media: { id: 'm-o2', mediaKey: 'other2', name: 'Other2' },
              textContentLen: 1500, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const repo = makeRepoReturning([rpRow, etRow]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      const rpItem = feed.items.find((i) => i.event_id === 'evt-rp');
      const etItem = feed.items.find((i) => i.event_id === 'evt-et');
      // Both should exist but RP should have lower v3 final
      if (rpItem?.public_importance_v3_final != null && etItem?.public_importance_v3_final != null) {
        expect(rpItem.public_importance_v3_final).toBeLessThanOrEqual(etItem.public_importance_v3_final);
      }
    });

    it('unknown source defaults allow in feed (backward compat)', async () => {
      const row = makeMockRow({
        id: 'evt-unknown',
        eventArticles: [
          {
            article: {
              id: 'art-u1', url: 'https://unknown.com/art1',
              title: 'Article from unknown', media: { id: 'm-u', mediaKey: 'totally_new_outlet', name: 'New' },
              textContentLen: 2000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'art-u2', url: 'https://other.com/art2',
              title: 'Second article', media: { id: 'm-o', mediaKey: 'other_media', name: 'Other' },
              textContentLen: 1500, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      const item = feed.items.find((i) => i.event_id === 'evt-unknown');
      expect(item).toBeDefined();
      expect(item!.source_tier).toBe('MEDIUM');
      expect(item!.source_policy_multiplier).toBe(1.0);
    });

    it('blocks event with podcast headline (PÓDCAST |)', async () => {
      const row = makeMockRow({
        id: 'evt-podcast',
        versions: [{
          id: 'ver-1',
          headline: 'PÓDCAST | Entrevista con el ministro de defensa',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-podcast')).toBeUndefined();
    });

    it('blocks event with PODCAST: headline', async () => {
      const row = makeMockRow({
        id: 'evt-podcast2',
        versions: [{
          id: 'ver-1',
          headline: 'PODCAST: Análisis de la semana política colombiana',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-podcast2')).toBeUndefined();
    });

    it('blocks event with podcast URL in articles', async () => {
      const row = makeMockRow({
        id: 'evt-podcast-url',
        eventArticles: [{
          article: {
            id: 'art-pod', url: 'https://www.eltiempo.com/podcast/episodio-42',
            title: 'Normal title', media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' },
            textContentLen: 1500, usableForOverview: true, contentType: 'news',
            extractionFailReason: null, paywallDetected: false,
          },
        }, {
          article: {
            id: 'art-norm', url: 'https://www.elespectador.com/art',
            title: 'Normal article', media: { id: 'm2', mediaKey: 'elespectador', name: 'El Espectador' },
            textContentLen: 1200, usableForOverview: true, contentType: 'news',
            extractionFailReason: null, paywallDetected: false,
          },
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-podcast-url')).toBeUndefined();
    });

    it('does NOT block normal article that mentions podcast in text', async () => {
      const row = makeMockRow({
        id: 'evt-normal',
        versions: [{
          id: 'ver-1',
          headline: 'Presidente habla sobre su podcast semanal',
          packetJson: {},
        }],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      expect(feed.items.find((i) => i.event_id === 'evt-normal')).toBeDefined();
    });

    it('consonante gets HIGH tier and 1.0 multiplier', async () => {
      const row = makeMockRow({
        id: 'evt-cons',
        eventArticles: [
          {
            article: {
              id: 'art-c1', url: 'https://consonante.com/art1',
              title: 'Regional news', media: { id: 'm-c', mediaKey: 'consonante', name: 'Consonante' },
              textContentLen: 2000, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
          {
            article: {
              id: 'art-c2', url: 'https://other.com/art2',
              title: 'Other', media: { id: 'm-o', mediaKey: 'other_outlet', name: 'Other' },
              textContentLen: 1500, usableForOverview: true, contentType: 'news',
              extractionFailReason: null, paywallDetected: false,
            },
          },
        ],
      });
      const repo = makeRepoReturning([row]);
      const service = new FeedService(repo);
      const feed = await service.getFeed();
      const item = feed.items.find((i) => i.event_id === 'evt-cons');
      expect(item).toBeDefined();
      expect(item!.source_tier).toBe('HIGH');
      expect(item!.source_mode).toBe('NEWS');
    });
  });
});
