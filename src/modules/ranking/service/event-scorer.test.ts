import { describe, it, expect, beforeEach } from 'vitest';
import {
  computeEventScore,
  rankEvents,
  setHotTopics,
  EventForScoring,
  ArticleForScoring,
} from './event-scorer.js';

function makeArticle(overrides: Partial<ArticleForScoring> = {}): ArticleForScoring {
  return {
    id: 'art-1',
    url: 'https://razonpublica.com/nota-1',
    title: 'Nota de prueba',
    snippet: 'Este es un fragmento de prueba con suficiente longitud para representar un artículo real de noticias colombianas sobre la reforma pensional.',
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

  it('importance grows with more articles', () => {
    const fewArticles = computeEventScore(makeEvent({ articles: [makeArticle()] }), now);
    const manyArticles = computeEventScore(
      makeEvent({
        articles: Array.from({ length: 8 }, (_, i) =>
          makeArticle({ id: `art-${i}`, mediaId: `media-${i}` }),
        ),
      }),
      now,
    );
    expect(manyArticles.components.importance).toBeGreaterThan(fewArticles.components.importance);
  });

  it('importance accounts for source diversity', () => {
    const sameSource = computeEventScore(
      makeEvent({
        articles: Array.from({ length: 5 }, (_, i) =>
          makeArticle({ id: `art-${i}`, mediaId: 'same-media' }),
        ),
      }),
      now,
    );
    const diverseSources = computeEventScore(
      makeEvent({
        articles: Array.from({ length: 5 }, (_, i) =>
          makeArticle({ id: `art-${i}`, mediaId: `media-${i}` }),
        ),
      }),
      now,
    );
    expect(diverseSources.components.importance).toBeGreaterThan(sameSource.components.importance);
  });

  it('momentum is high when articles are recent', () => {
    const recentArticles = Array.from({ length: 3 }, (_, i) =>
      makeArticle({
        id: `art-${i}`,
        publishedAt: new Date('2025-01-15T12:00:00Z'), // 2h before now
      }),
    );
    const result = computeEventScore(makeEvent({ articles: recentArticles }), now);
    expect(result.components.momentum).toBeGreaterThan(0);
  });

  it('momentum is zero when no articles in 6h window', () => {
    const oldArticles = [
      makeArticle({ publishedAt: new Date('2025-01-14T10:00:00Z') }), // 28h before now
    ];
    const result = computeEventScore(makeEvent({ articles: oldArticles }), now);
    expect(result.components.momentum).toBe(0);
  });

  it('recency decays over time', () => {
    const recent = computeEventScore(
      makeEvent({ publishedAt: new Date('2025-01-15T13:00:00Z') }), // 1h ago
      now,
    );
    const old = computeEventScore(
      makeEvent({ publishedAt: new Date('2025-01-13T10:00:00Z') }), // 2 days ago
      now,
    );
    expect(recent.components.recency).toBeGreaterThan(old.components.recency);
  });

  it('quality is higher with headline and long snippets', () => {
    const withHeadline = computeEventScore(
      makeEvent({
        headline: 'Good headline',
        articles: [makeArticle({ snippet: 'A'.repeat(500) })],
      }),
      now,
    );
    const noHeadline = computeEventScore(
      makeEvent({
        headline: null,
        articles: [makeArticle({ snippet: 'Short' })],
      }),
      now,
    );
    expect(withHeadline.components.quality).toBeGreaterThan(noHeadline.components.quality);
  });

  it('topic boost activates when event matches hot topics', () => {
    setHotTopics(['politics', 'economy']);
    const result = computeEventScore(makeEvent({ topicKeys: ['politics'] }), now);
    expect(result.components.topicBoost).toBeGreaterThan(0);
  });

  it('topic boost is zero when no hot topics match', () => {
    setHotTopics(['sports']);
    const result = computeEventScore(makeEvent({ topicKeys: ['politics'] }), now);
    expect(result.components.topicBoost).toBe(0);
  });

  it('topic boost is zero when no hot topics set', () => {
    setHotTopics([]);
    const result = computeEventScore(makeEvent({ topicKeys: ['politics'] }), now);
    expect(result.components.topicBoost).toBe(0);
  });

  it('junk penalty applies for ads-like articles', () => {
    const junkArticle = makeArticle({
      url: 'https://example.com/patrocinado/oferta',
      title: 'Oferta gratis exclusiva',
      snippet: 'Compra ahora con descuento',
    });
    const result = computeEventScore(makeEvent({ articles: [junkArticle] }), now);
    expect(result.components.junkPenalty).toBeGreaterThan(0);
  });

  it('excludes event when majority of articles are junk', () => {
    // Each article needs to score ≥ 0.75 without authorOrSection
    // url_pattern(0.35) + title_keywords x2(0.30) + short_snippet(0.10) + seo(0.20) = 0.95
    const junkArticles = Array.from({ length: 3 }, (_, i) =>
      makeArticle({
        id: `junk-${i}`,
        url: `https://example.com/patrocinado/tienda/oferta-${i}`,
        title: 'Oferta exclusiva ¡no te pierdas este top 10 descuento!',
        snippet: 'Haz clic aquí. Haz clic aquí para leer más.',
      }),
    );
    const result = computeEventScore(makeEvent({ articles: junkArticles }), now);
    expect(result.junkExcluded).toBe(true);
    expect(result.score).toBe(-1);
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

  it('breaks ties by source count then publishedAt', () => {
    const evt1 = makeEvent({
      id: 'evt-1',
      publishedAt: new Date('2025-01-15T13:00:00Z'),
      articles: [
        makeArticle({ id: 'a1', mediaId: 'm1' }),
        makeArticle({ id: 'a2', mediaId: 'm2' }),
      ],
    });
    const evt2 = makeEvent({
      id: 'evt-2',
      publishedAt: new Date('2025-01-15T13:30:00Z'),
      articles: [
        makeArticle({ id: 'a3', mediaId: 'm3' }),
        makeArticle({ id: 'a4', mediaId: 'm4' }),
        makeArticle({ id: 'a5', mediaId: 'm5' }),
      ],
    });
    // evt2 has more sources, should rank higher if scores tie or are close
    const ranked = rankEvents([evt1, evt2], now);
    // evt2 should be first (more sources + more recent)
    expect(ranked[0].eventId).toBe('evt-2');
  });

  it('returns empty array for empty input', () => {
    const ranked = rankEvents([], now);
    expect(ranked).toEqual([]);
  });
});
