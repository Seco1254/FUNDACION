import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeEventScore,
  rankEvents,
  setHotTopics,
  EventForScoring,
  ArticleForScoring,
  ClaimForScoring,
} from './event-scorer.js';

function makeArticle(overrides: Partial<ArticleForScoring> = {}): ArticleForScoring {
  return {
    id: 'art-1',
    url: 'https://razonpublica.com/nota-1',
    title: 'Nota de prueba',
    snippet: 'Este es un fragmento de prueba con suficiente longitud para representar un artículo real de noticias colombianas sobre la reforma pensional que se discute en el Congreso.',
    mediaId: 'media-1',
    publishedAt: new Date('2025-01-15T10:00:00Z'),
    createdAt: new Date('2025-01-15T10:00:00Z'),
    ...overrides,
  };
}

function makeEvent(overrides: Partial<EventForScoring> = {}): EventForScoring {
  return {
    id: 'evt-1',
    publishedAt: new Date('2025-01-15T10:00:00Z'),
    tLast: new Date('2025-01-15T12:00:00Z'),
    t0: new Date('2025-01-15T08:00:00Z'),
    articles: [makeArticle()],
    headline: 'Reforma pensional aprobada',
    topicKeys: ['politics'],
    claims: [],
    ...overrides,
  };
}

describe('computeEventScore', () => {
  const now = new Date('2025-01-15T14:00:00Z');

  beforeEach(() => {
    setHotTopics([]);
  });

  it('produces a positive score for a normal event', () => {
    const result = computeEventScore(makeEvent(), now);
    expect(result.score).toBeGreaterThan(0);
    expect(result.junkExcluded).toBe(false);
  });

  // ── I: Importance ──

  it('2 medios rankea > 1 medio con mismo n_arts', () => {
    const singleMedia = computeEventScore(
      makeEvent({
        articles: Array.from({ length: 4 }, (_, i) =>
          makeArticle({ id: `art-${i}`, mediaId: 'media-A' }),
        ),
      }),
      now,
    );
    const twoMedia = computeEventScore(
      makeEvent({
        articles: [
          makeArticle({ id: 'a1', mediaId: 'media-A' }),
          makeArticle({ id: 'a2', mediaId: 'media-A' }),
          makeArticle({ id: 'a3', mediaId: 'media-B' }),
          makeArticle({ id: 'a4', mediaId: 'media-B' }),
        ],
      }),
      now,
    );
    expect(twoMedia.components.importance).toBeGreaterThan(singleMedia.components.importance);
  });

  it('per-media cap: 10 arts 1 media loses vs 3+3 from 2 media', () => {
    const mono = computeEventScore(
      makeEvent({
        articles: Array.from({ length: 10 }, (_, i) =>
          makeArticle({ id: `art-${i}`, mediaId: 'media-X' }),
        ),
      }),
      now,
    );
    const diverse = computeEventScore(
      makeEvent({
        articles: [
          ...Array.from({ length: 3 }, (_, i) =>
            makeArticle({ id: `a-${i}`, mediaId: 'media-A' }),
          ),
          ...Array.from({ length: 3 }, (_, i) =>
            makeArticle({ id: `b-${i}`, mediaId: 'media-B' }),
          ),
        ],
      }),
      now,
    );
    expect(diverse.components.importance).toBeGreaterThan(mono.components.importance);
  });

  it('dominance >70% applies -0.05 penalty', () => {
    const dominant = computeEventScore(
      makeEvent({
        articles: [
          ...Array.from({ length: 8 }, (_, i) =>
            makeArticle({ id: `a-${i}`, mediaId: 'media-A' }),
          ),
          ...Array.from({ length: 2 }, (_, i) =>
            makeArticle({ id: `b-${i}`, mediaId: 'media-B' }),
          ),
        ],
      }),
      now,
    );
    expect(dominant.dominancePenalty).toBe(true);

    const balanced = computeEventScore(
      makeEvent({
        articles: [
          ...Array.from({ length: 5 }, (_, i) =>
            makeArticle({ id: `a-${i}`, mediaId: 'media-A' }),
          ),
          ...Array.from({ length: 5 }, (_, i) =>
            makeArticle({ id: `b-${i}`, mediaId: 'media-B' }),
          ),
        ],
      }),
      now,
    );
    expect(balanced.dominancePenalty).toBe(false);
    expect(balanced.score).toBeGreaterThan(dominant.score);
  });

  it('importance uses sigmoid(log(1+n_arts_eff)*log(1+n_unique_media))', () => {
    const result = computeEventScore(makeEvent({ articles: [makeArticle()] }), now);
    const expected = 1 / (1 + Math.exp(-(Math.log(2) * Math.log(2))));
    expect(result.components.importance).toBeCloseTo(expected, 6);
  });

  // ── M: Momentum ──

  it('momentum uses sigmoid(Δn_arts_6h + 2*Δn_unique_media_6h)', () => {
    const recentArticles = [
      makeArticle({ id: 'a1', mediaId: 'm1', publishedAt: new Date('2025-01-15T12:00:00Z') }),
      makeArticle({ id: 'a2', mediaId: 'm2', publishedAt: new Date('2025-01-15T12:00:00Z') }),
      makeArticle({ id: 'a3', mediaId: 'm1', publishedAt: new Date('2025-01-15T13:00:00Z') }),
    ];
    const result = computeEventScore(makeEvent({ articles: recentArticles }), now);
    const expected = 1 / (1 + Math.exp(-(3 + 2 * 2)));
    expect(result.components.momentum).toBeCloseTo(expected, 3);
  });

  it('junk >= 0.45 does NOT count in momentum', () => {
    // url_pattern(0.35) + title_keyword_1(0.15) + short_snippet(0.10) = 0.60
    const junkishArticle = makeArticle({
      id: 'junkish',
      url: 'https://example.com/patrocinado/nota',
      title: 'Oferta de prueba',
      snippet: 'Corto.',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
    });
    const normalArticle = makeArticle({
      id: 'normal',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
    });

    const withJunk = computeEventScore(
      makeEvent({ articles: [junkishArticle, normalArticle] }),
      now,
    );
    const allNormal = computeEventScore(
      makeEvent({ articles: [normalArticle, makeArticle({ id: 'n2', publishedAt: new Date('2025-01-15T13:00:00Z') })] }),
      now,
    );
    expect(withJunk.updatesIn6h).toBeLessThan(allNormal.updatesIn6h);
  });

  // ── Q: Quality (claims-based) ──

  it('Q = 0 when no claims', () => {
    const result = computeEventScore(makeEvent({ claims: [] }), now);
    expect(result.components.quality).toBe(0);
  });

  it('Q = claims_supported / claims_total', () => {
    const claims: ClaimForScoring[] = [
      { status: 'SUPPORTED' },
      { status: 'SUPPORTED' },
      { status: 'DISPUTED' },
      { status: 'INSUFFICIENT' },
    ];
    const result = computeEventScore(makeEvent({ claims }), now);
    expect(result.components.quality).toBeCloseTo(0.5, 6);
  });

  it('Q capped at 1', () => {
    const result = computeEventScore(
      makeEvent({ claims: [{ status: 'SUPPORTED' }, { status: 'SUPPORTED' }] }),
      now,
    );
    expect(result.components.quality).toBe(1);
  });

  // ── R: Recency ──

  it('recency decays over time', () => {
    const recent = computeEventScore(
      makeEvent({ publishedAt: new Date('2025-01-15T13:00:00Z') }),
      now,
    );
    const old = computeEventScore(
      makeEvent({ publishedAt: new Date('2025-01-13T10:00:00Z') }),
      now,
    );
    expect(recent.components.recency).toBeGreaterThan(old.components.recency);
  });

  // ── T: TopicBoost ──

  it('topic boost activates when event matches hot topics', () => {
    setHotTopics(['politics', 'economy']);
    const result = computeEventScore(makeEvent({ topicKeys: ['politics'] }), now);
    expect(result.components.topicBoost).toBeGreaterThan(0);
  });

  it('topic boost is zero when no hot topics set', () => {
    setHotTopics([]);
    const result = computeEventScore(makeEvent({ topicKeys: ['politics'] }), now);
    expect(result.components.topicBoost).toBe(0);
  });

  // ── J: JunkPenalty ──

  it('junk >= 0.75 excludes all-junk event', () => {
    const allJunk = Array.from({ length: 3 }, (_, i) =>
      makeArticle({
        id: `junk-${i}`,
        url: `https://example.com/patrocinado/tienda/oferta-${i}`,
        title: 'Oferta exclusiva ¡no te pierdas este top 10 descuento!',
        snippet: 'Haz clic aquí. Haz clic aquí para leer más.',
      }),
    );
    const result = computeEventScore(makeEvent({ articles: allJunk }), now);
    expect(result.junkExcluded).toBe(true);
    expect(result.score).toBe(-1);
  });

  it('event with mix of junk and normal is NOT excluded', () => {
    const articles = [
      makeArticle({ id: 'normal' }),
      makeArticle({
        id: 'junk',
        url: 'https://example.com/patrocinado/tienda/oferta',
        title: 'Oferta exclusiva ¡no te pierdas este top 10 descuento!',
        snippet: 'Haz clic aquí. Haz clic aquí para leer más.',
      }),
    ];
    const result = computeEventScore(makeEvent({ articles }), now);
    expect(result.junkExcluded).toBe(false);
  });

  it('all components are in [0, 1]', () => {
    const result = computeEventScore(makeEvent(), now);
    const { importance, momentum, recency, quality, topicBoost, junkPenalty } = result.components;
    for (const val of [importance, momentum, recency, quality, topicBoost, junkPenalty]) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });
});

describe('rankEvents', () => {
  const now = new Date('2025-01-15T14:00:00Z');

  beforeEach(() => {
    setHotTopics([]);
  });

  it('ranks events by score descending', () => {
    const important = makeEvent({
      id: 'evt-important',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
      articles: Array.from({ length: 10 }, (_, i) =>
        makeArticle({ id: `art-${i}`, mediaId: `media-${i}` }),
      ),
    });
    const minor = makeEvent({
      id: 'evt-minor',
      publishedAt: new Date('2025-01-14T10:00:00Z'),
      articles: [makeArticle({ id: 'art-only', mediaId: 'media-0' })],
      headline: null,
    });
    const ranked = rankEvents([minor, important], now);
    expect(ranked[0].eventId).toBe('evt-important');
    expect(ranked[1].eventId).toBe('evt-minor');
  });

  it('filters out junk-excluded events', () => {
    const normal = makeEvent({ id: 'evt-normal' });
    const junk = makeEvent({
      id: 'evt-junk',
      articles: Array.from({ length: 3 }, (_, i) =>
        makeArticle({
          id: `junk-${i}`,
          url: `https://example.com/patrocinado/tienda/oferta-${i}`,
          title: 'Oferta exclusiva ¡no te pierdas este top 10 descuento!',
          snippet: 'Haz clic aquí. Haz clic aquí para leer más.',
        }),
      ),
    });
    const ranked = rankEvents([normal, junk], now);
    expect(ranked.find((r) => r.eventId === 'evt-junk')).toBeUndefined();
    expect(ranked.length).toBe(1);
  });

  it('tie-breaker 1: unique media desc', () => {
    const moreMedia = makeEvent({
      id: 'evt-more-media',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
      articles: [
        makeArticle({ id: 'a1', mediaId: 'm1', publishedAt: new Date('2025-01-15T13:00:00Z') }),
        makeArticle({ id: 'a2', mediaId: 'm2', publishedAt: new Date('2025-01-15T13:00:00Z') }),
        makeArticle({ id: 'a3', mediaId: 'm3', publishedAt: new Date('2025-01-15T13:00:00Z') }),
      ],
    });
    const lessMedia = makeEvent({
      id: 'evt-less-media',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
      articles: [
        makeArticle({ id: 'b1', mediaId: 'm1', publishedAt: new Date('2025-01-15T13:00:00Z') }),
        makeArticle({ id: 'b2', mediaId: 'm1', publishedAt: new Date('2025-01-15T13:00:00Z') }),
        makeArticle({ id: 'b3', mediaId: 'm1', publishedAt: new Date('2025-01-15T13:00:00Z') }),
      ],
    });
    const ranked = rankEvents([lessMedia, moreMedia], now);
    expect(ranked[0].eventId).toBe('evt-more-media');
  });

  it('returns empty array for empty input', () => {
    const ranked = rankEvents([], now);
    expect(ranked).toEqual([]);
  });
});
