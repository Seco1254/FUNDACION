import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, EventEnvelope } from '../../../core/event_bus/index.js';
import {
  scoreTopicsForText,
  detectEmergentTopics,
  buildHeatmap,
  TopicAssigner,
} from './topic-assigner.js';
import { ulid } from 'ulid';

describe('Topics assignment', () => {
  it('assigns correct topic for economia keywords', () => {
    const text = 'La inflación aumentó y el dolar se disparó afectando el presupuesto fiscal del gobierno económico';
    const scores = scoreTopicsForText(text);
    expect(scores.length).toBeGreaterThan(0);
    expect(scores[0].topic_key).toBe('ECONOMIA');
  });

  it('assigns correct topic for seguridad keywords', () => {
    const text = 'El ejército militar combatió la violencia del narcotrafico y la guerrilla en el conflicto armado';
    const scores = scoreTopicsForText(text);
    expect(scores[0].topic_key).toBe('SEGURIDAD');
  });

  it('assigns correct topic for politica keywords', () => {
    const text = 'El presidente y el congreso aprobaron la reforma política con apoyo del partido y la coalición';
    const scores = scoreTopicsForText(text);
    expect(scores[0].topic_key).toBe('POLITICA');
  });

  it('returns OTROS when no keywords match above threshold', () => {
    const text = 'Hoy es un día normal sin ninguna noticia relevante o importante que reportar';
    const scores = scoreTopicsForText(text);
    expect(scores).toHaveLength(1);
    expect(scores[0].topic_key).toBe('OTROS');
  });

  it('returns top-2 topics max', () => {
    // Mix of economia and politica keywords
    const text = 'El gobierno presidente aprobó la reforma tributaria fiscal con impuesto al dolar en el congreso partido coalición presupuesto economico';
    const scores = scoreTopicsForText(text);
    expect(scores.length).toBeLessThanOrEqual(2);
  });

  it('is deterministic: same input → same scores', () => {
    const text = 'La inflación del presupuesto fiscal afectó la economia nacional';
    const s1 = scoreTopicsForText(text);
    const s2 = scoreTopicsForText(text);
    expect(s1).toEqual(s2);
  });
});

describe('Emergent topics detection', () => {
  it('creates emergent topic when n-gram appears in ≥3 articles', () => {
    const claimTexts = [
      'metaverso criptoactivo transformacion paradigma avanzada',
      'metaverso criptoactivo nuevo concepto revolucion',
      'metaverso criptoactivo impacto sociedad colombiana',
    ];
    const emergent = detectEmergentTopics(claimTexts, 3);
    expect(emergent.length).toBeGreaterThan(0);
    expect(emergent[0]).toMatch(/^EMERG_/);
  });

  it('does not create emergent for closed-topic keywords', () => {
    const claimTexts = [
      'economia inflacion gobierno fiscal presupuesto nacional',
      'economia inflacion gobierno fiscal presupuesto estatal',
      'economia inflacion gobierno fiscal presupuesto regional',
    ];
    // "economia inflacion" maps to closed topic ECONOMIA
    const emergent = detectEmergentTopics(claimTexts, 3);
    // Should not include an emergent that maps to closed keyword
    for (const e of emergent) {
      expect(e).not.toContain('ECONOMIA');
    }
  });

  it('limits to max 3 emergent topics', () => {
    const claimTexts: string[] = [];
    for (let i = 0; i < 10; i++) {
      claimTexts.push(`novel${i} concept${i} unique${i} pattern${i} extra${i}`);
    }
    const emergent = detectEmergentTopics(claimTexts, 10);
    expect(emergent.length).toBeLessThanOrEqual(3);
  });

  it('does not create emergent with fewer than 3 articles', () => {
    const claimTexts = ['something unique rare', 'something unique rare'];
    const emergent = detectEmergentTopics(claimTexts, 2);
    expect(emergent).toHaveLength(0);
  });
});

describe('Heatmap bins', () => {
  it('places articles in correct bins', () => {
    const t0 = new Date('2025-06-15T00:00:00.000Z');
    const articles = [
      {
        publishedAt: new Date('2025-06-15T02:00:00.000Z'), // bin 0 (0-6h)
        topicScores: [{ topic_key: 'ECONOMIA', weight: 0.5 }],
      },
      {
        publishedAt: new Date('2025-06-15T08:00:00.000Z'), // bin 1 (6-12h)
        topicScores: [{ topic_key: 'POLITICA', weight: 0.7 }],
      },
      {
        publishedAt: new Date('2025-06-15T14:00:00.000Z'), // bin 2 (12-18h)
        topicScores: [{ topic_key: 'ECONOMIA', weight: 0.3 }],
      },
    ];

    const heatmap = buildHeatmap(articles, t0);

    expect(heatmap).toHaveLength(28);
    // Bin 0 should have ECONOMIA
    expect(heatmap[0].topics).toHaveProperty('ECONOMIA');
    expect(heatmap[0].topics.ECONOMIA).toBe(1); // normalized to 1 since only topic
    // Bin 1 should have POLITICA
    expect(heatmap[1].topics).toHaveProperty('POLITICA');
    // Bin 2 should have ECONOMIA
    expect(heatmap[2].topics).toHaveProperty('ECONOMIA');
  });

  it('normalizes per-bin', () => {
    const t0 = new Date('2025-06-15T00:00:00.000Z');
    const articles = [
      {
        publishedAt: new Date('2025-06-15T02:00:00.000Z'),
        topicScores: [
          { topic_key: 'ECONOMIA', weight: 0.6 },
          { topic_key: 'POLITICA', weight: 0.4 },
        ],
      },
    ];

    const heatmap = buildHeatmap(articles, t0);
    const bin0topics = heatmap[0].topics;
    const total = Object.values(bin0topics).reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 2);
  });

  it('ignores articles before t0 or after 7 days', () => {
    const t0 = new Date('2025-06-15T00:00:00.000Z');
    const articles = [
      {
        publishedAt: new Date('2025-06-14T23:00:00.000Z'), // before t0
        topicScores: [{ topic_key: 'ECONOMIA', weight: 0.5 }],
      },
      {
        publishedAt: new Date('2025-06-23T00:00:00.000Z'), // after 7 days (28 bins)
        topicScores: [{ topic_key: 'POLITICA', weight: 0.5 }],
      },
    ];

    const heatmap = buildHeatmap(articles, t0);
    const hasAnyTopic = heatmap.some((bin) => Object.keys(bin.topics).length > 0);
    expect(hasAnyTopic).toBe(false);
  });
});

describe('TopicAssigner handler', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let topicRepo: any;
  let eventRepo: any;
  let claimRepo: any;
  let versionRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    published = [];
    eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });

    topicRepo = {
      countByVersion: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    };

    eventRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'ev-1',
        t0: new Date('2025-06-15T00:00:00.000Z'),
      }),
      findArticlesForEvent: vi.fn().mockResolvedValue([
        {
          id: 'art-1',
          mediaId: 'media-1',
          title: 'La inflación económica del presupuesto fiscal subió un 15% en el mercado financiero',
          snippet: 'El banco central reportó un incremento de precios en la economía nacional del país.',
          publishedAt: new Date('2025-06-15T02:00:00.000Z'),
        },
      ]),
    };

    claimRepo = {
      findClaimsByVersion: vi.fn().mockResolvedValue([]),
    };

    versionRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'ver-1',
        packetJson: {},
      }),
      update: vi.fn().mockResolvedValue({}),
    };

    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
  });

  it('creates topic assignments and emits TopicHeatmapBuilt', async () => {
    const assigner = new TopicAssigner(eventRepo, claimRepo, topicRepo, versionRepo, eventBus, auditWriter);
    await assigner.handler()({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });

    expect(topicRepo.create).toHaveBeenCalled();
    expect(versionRepo.update).toHaveBeenCalledOnce();

    const updatedPacket = versionRepo.update.mock.calls[0][1].packetJson;
    expect(updatedPacket).toHaveProperty('topics');
    expect(updatedPacket.topics).toHaveProperty('top_topics');
    expect(updatedPacket.topics).toHaveProperty('emergent');
    expect(updatedPacket).toHaveProperty('topics_heatmap');
    expect(Array.isArray(updatedPacket.topics_heatmap)).toBe(true);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('TopicHeatmapBuilt');
  });

  it('skips if topics already assigned (idempotency)', async () => {
    topicRepo.countByVersion.mockResolvedValue(5);
    const assigner = new TopicAssigner(eventRepo, claimRepo, topicRepo, versionRepo, eventBus, auditWriter);
    await assigner.handler()({
      event_name: 'OverviewGenerated',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1', version_index: 0, gate_status: 'PASS' },
    });
    expect(topicRepo.create).not.toHaveBeenCalled();
  });
});
