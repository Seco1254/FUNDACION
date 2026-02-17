import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, EventEnvelope } from '../../../core/event_bus/index.js';
import {
  extractFeatures,
  classifyPrimary,
  classifySecondary,
  computeIntensity,
  buildSignals,
  buildRationale,
} from './feature-extractor.js';
import { BiasProfiler } from './bias-profiler.js';
import { ulid } from 'ulid';

describe('Feature extractor (determinism)', () => {
  it('same input → same features', () => {
    const text = 'El gobierno denunció la terrible crisis económica del país';
    const f1 = extractFeatures(text);
    const f2 = extractFeatures(text);
    expect(f1).toEqual(f2);
  });

  it('same input → same primary label', () => {
    const text = 'El gobierno denunció la terrible crisis económica del país';
    const f = extractFeatures(text);
    const c1 = classifyPrimary(f);
    const c2 = classifyPrimary(f);
    expect(c1.label).toBe(c2.label);
    expect(c1.confidence).toBe(c2.confidence);
  });

  it('same input → same secondary label', () => {
    const text = 'El gobierno logró un avance histórico según el ministerio';
    const f = extractFeatures(text);
    const s1 = classifySecondary(f);
    const s2 = classifySecondary(f);
    expect(s1.label).toBe(s2.label);
    expect(s1.confidence).toBe(s2.confidence);
  });

  it('detects emotional features in emotional text', () => {
    const text = 'Es terrible e indignante lo que pasó, una catástrofe alarmante y devastadora';
    const f = extractFeatures(text);
    expect(f.emotional).toBeGreaterThan(0);
  });

  it('detects critical features in critical text', () => {
    const text = 'El fiscal criticó y denunció las irregularidades del gobierno, advirtió sobre la corrupción';
    const f = extractFeatures(text);
    expect(f.critical).toBeGreaterThan(0);
  });

  it('detects institutional features in institutional text', () => {
    const text = 'El ministerio comunicó oficialmente según la resolución del gobierno nacional mediante decreto';
    const f = extractFeatures(text);
    expect(f.institutional).toBeGreaterThan(0);
  });

  it('detects technical features in technical text', () => {
    const text = 'El porcentaje de crecimiento fue del 3.5% según el indicador de tasa de variación del estudio';
    const f = extractFeatures(text);
    expect(f.technical).toBeGreaterThan(0);
  });

  it('computeIntensity is in [0,1]', () => {
    const f = extractFeatures('texto neutral simple sin señales');
    const intensity = computeIntensity(f);
    expect(intensity).toBeGreaterThanOrEqual(0);
    expect(intensity).toBeLessThanOrEqual(1);
  });

  it('buildSignals returns at least one signal', () => {
    const f = extractFeatures('texto neutral');
    const signals = buildSignals(f);
    expect(signals.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Bias rationale anchored', () => {
  it('evidence_refs reference existing quote/claim/article ids', () => {
    const features = extractFeatures('El gobierno denunció la crisis');
    const primary = classifyPrimary(features);
    const quotes = [
      { quote_id: 'q-1', text: 'El gobierno denunció', url: 'https://example.com/1' },
    ];
    const evidenceRefs = [
      { type: 'article' as const, id: 'art-1' },
      { type: 'quote' as const, id: 'q-1' },
    ];

    const rationale = buildRationale(features, primary.label, quotes, evidenceRefs);

    expect(rationale.why_short).toBeTruthy();
    expect(rationale.why_signals.length).toBeGreaterThan(0);
    expect(rationale.evidence_refs).toEqual(evidenceRefs);
    expect(rationale.why_quotes).toHaveLength(1);
    expect(rationale.why_quotes[0].quote_id).toBe('q-1');
  });

  it('rationale never creates non-existent refs', () => {
    const features = extractFeatures('texto simple');
    const rationale = buildRationale(features, 'NEUTRO', [], []);
    expect(rationale.evidence_refs).toHaveLength(0);
    expect(rationale.why_quotes).toHaveLength(0);
  });
});

describe('BiasProfiler handler', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let biasRepo: any;
  let mediaProfileRepo: any;
  let eventRepo: any;
  let claimRepo: any;
  let mediaRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    published = [];
    eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });

    const createdLabels: any[] = [];
    biasRepo = {
      countByVersion: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockImplementation(async (data: any) => {
        const label = { id: `bl-${createdLabels.length + 1}`, ...data };
        createdLabels.push(label);
        return label;
      }),
      findMediaLevelByEvent: vi.fn().mockResolvedValue([]),
      findArticleLevelByEvent: vi.fn().mockResolvedValue([]),
    };

    mediaProfileRepo = {
      findByMediaId: vi.fn().mockResolvedValue(null),
      upsert: vi.fn().mockResolvedValue({}),
    };

    eventRepo = {
      findArticlesForEvent: vi.fn().mockResolvedValue([
        {
          id: 'art-1',
          mediaId: 'media-1',
          title: 'El gobierno denunció la terrible crisis económica que afecta al país entero',
          snippet: 'El ministro criticó las políticas anteriores como un fracaso total del sistema financiero.',
          url: 'https://example.com/1',
          publishedAt: new Date(),
        },
      ]),
    };

    claimRepo = {
      findClaimsWithQuotesByVersion: vi.fn().mockResolvedValue([
        {
          id: 'claim-1',
          claimText: 'crisis económica',
          status: 'SUPPORTED',
          quotes: [
            { id: 'q-1', articleId: 'art-1', quoteText: 'crisis económica', article: { url: 'https://example.com/1' } },
          ],
        },
      ]),
    };

    mediaRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'media-1', mediaKey: 'eltiempo' }),
    };

    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
  });

  it('creates article-level and media-level bias labels', async () => {
    const profiler = new BiasProfiler(eventRepo, claimRepo, biasRepo, mediaProfileRepo, mediaRepo, eventBus, auditWriter);
    const handler = profiler.handler();

    await handler({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });

    // Should create 1 article-level + 1 media-level
    expect(biasRepo.create).toHaveBeenCalledTimes(2);
    const calls = biasRepo.create.mock.calls;
    expect(calls[0][0].scope).toBe('ARTICLE_LEVEL');
    expect(calls[1][0].scope).toBe('MEDIA_LEVEL');

    // Should emit BiasLabelsBuilt
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('BiasLabelsBuilt');
  });

  it('skips if bias already exists (idempotency)', async () => {
    biasRepo.countByVersion.mockResolvedValue(5);
    const profiler = new BiasProfiler(eventRepo, claimRepo, biasRepo, mediaProfileRepo, mediaRepo, eventBus, auditWriter);
    await profiler.handler()({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });
    expect(biasRepo.create).not.toHaveBeenCalled();
  });

  it('updates media profile incrementally', async () => {
    const profiler = new BiasProfiler(eventRepo, claimRepo, biasRepo, mediaProfileRepo, mediaRepo, eventBus, auditWriter);
    await profiler.handler()({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });
    expect(mediaProfileRepo.upsert).toHaveBeenCalledOnce();
    const upsertCall = mediaProfileRepo.upsert.mock.calls[0];
    expect(upsertCall[0]).toBe('media-1');
    expect(upsertCall[1]).toHaveProperty('avg_features');
    expect(upsertCall[1]).toHaveProperty('articles_processed', 1);
  });

  it('rationale references existing evidence (anchored)', async () => {
    const profiler = new BiasProfiler(eventRepo, claimRepo, biasRepo, mediaProfileRepo, mediaRepo, eventBus, auditWriter);
    await profiler.handler()({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });

    const articleLevelCall = biasRepo.create.mock.calls[0][0];
    const rationale = articleLevelCall.rationaleJson;
    expect(rationale.evidence_refs.length).toBeGreaterThan(0);
    // All evidence refs should reference real IDs
    for (const ref of rationale.evidence_refs) {
      expect(['article', 'quote', 'claim']).toContain(ref.type);
      expect(ref.id).toBeTruthy();
    }
  });
});
