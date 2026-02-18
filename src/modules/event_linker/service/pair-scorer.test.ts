import { describe, it, expect } from 'vitest';
import {
  scoreCandidates,
  decideLinkAction,
  extractEntities,
  THETA_AUTO_LINK,
  THETA_MAYBE_LINK,
  ArticleForPairing,
  EventCandidate,
} from './pair-scorer.js';

function makeVec(seed: number): number[] {
  // Deterministic 256-dim vector
  const vec = new Array(256).fill(0);
  vec[seed % 256] = 1;
  vec[(seed * 7 + 3) % 256] = 0.8;
  vec[(seed * 13 + 5) % 256] = 0.5;
  // L2 normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

function makeArticle(overrides: Partial<ArticleForPairing> = {}): ArticleForPairing {
  return {
    id: 'art-1',
    title: 'Reforma Pensional aprobada en Colombia',
    snippet: 'El Congreso de la República aprobó la reforma pensional propuesta por Gustavo Petro.',
    embeddingVec: makeVec(42),
    publishedAt: new Date('2025-01-15T10:00:00Z'),
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<EventCandidate> = {}): EventCandidate {
  return {
    id: 'evt-1',
    t0: new Date('2025-01-14T08:00:00Z'),
    tLast: new Date('2025-01-15T09:00:00Z'),
    articleVecs: [makeVec(42), makeVec(43)],
    articleTexts: [
      'Reforma Pensional avanza en el Congreso de la República',
      'Gustavo Petro impulsa la reforma pensional en Colombia',
    ],
    articleCount: 2,
    ...overrides,
  };
}

describe('extractEntities', () => {
  it('extracts capitalized multi-word sequences', () => {
    const entities = extractEntities('Juan Manuel Santos visitó el Congreso de la República');
    expect(entities.has('juan manuel santos')).toBe(true);
    expect(entities.has('congreso de la república')).toBe(true);
  });

  it('extracts quoted terms', () => {
    const entities = extractEntities('El proyecto "Reforma Tributaria" fue aprobado');
    expect(entities.has('reforma tributaria')).toBe(true);
  });

  it('returns empty set for text without entities', () => {
    const entities = extractEntities('un texto sin nombres propios');
    expect(entities.size).toBe(0);
  });
});

describe('scoreCandidates', () => {
  it('produces scores for each candidate', () => {
    const article = makeArticle();
    const candidates = [
      makeCandidate({ id: 'evt-1' }),
      makeCandidate({ id: 'evt-2', articleVecs: [makeVec(100)] }),
    ];
    const scores = scoreCandidates(article, candidates);
    expect(scores.length).toBe(2);
    expect(scores[0].compositeScore).toBeGreaterThanOrEqual(0);
    expect(scores[0].compositeScore).toBeLessThanOrEqual(1);
  });

  it('ranks closer embeddings higher', () => {
    const article = makeArticle({ embeddingVec: makeVec(42) });
    const close = makeCandidate({ id: 'evt-close', articleVecs: [makeVec(42)] });
    const far = makeCandidate({ id: 'evt-far', articleVecs: [makeVec(200)] });
    const scores = scoreCandidates(article, [far, close]);
    expect(scores[0].eventId).toBe('evt-close');
  });

  it('skips candidates with no vectors', () => {
    const article = makeArticle();
    const empty = makeCandidate({ id: 'evt-empty', articleVecs: [] });
    const scores = scoreCandidates(article, [empty]);
    expect(scores.length).toBe(0);
  });

  it('includes entity overlap in score', () => {
    const article = makeArticle({
      title: 'Gustavo Petro firma decreto',
      snippet: 'El presidente Gustavo Petro firmó el decreto.',
    });
    const withEntities = makeCandidate({
      id: 'evt-entities',
      articleTexts: ['Gustavo Petro anuncia medidas económicas'],
    });
    const withoutEntities = makeCandidate({
      id: 'evt-no-entities',
      articleTexts: ['Un texto sin nombres propios relevantes'],
    });
    const scores = scoreCandidates(article, [withEntities, withoutEntities]);
    const entitiesScore = scores.find((s) => s.eventId === 'evt-entities');
    const noEntitiesScore = scores.find((s) => s.eventId === 'evt-no-entities');
    expect(entitiesScore!.entityOverlap).toBeGreaterThan(noEntitiesScore!.entityOverlap);
  });

  it('temporal proximity is higher for closer events', () => {
    const article = makeArticle({ publishedAt: new Date('2025-01-15T10:00:00Z') });
    const recent = makeCandidate({
      id: 'evt-recent',
      t0: new Date('2025-01-14T10:00:00Z'),
      tLast: new Date('2025-01-15T08:00:00Z'),
    });
    const old = makeCandidate({
      id: 'evt-old',
      t0: new Date('2025-01-01T10:00:00Z'),
      tLast: new Date('2025-01-02T08:00:00Z'),
    });
    const scores = scoreCandidates(article, [old, recent]);
    const recentScore = scores.find((s) => s.eventId === 'evt-recent');
    const oldScore = scores.find((s) => s.eventId === 'evt-old');
    expect(recentScore!.temporalProximity).toBeGreaterThan(oldScore!.temporalProximity);
  });
});

describe('decideLinkAction', () => {
  it('returns CREATE when no candidates', async () => {
    const result = await decideLinkAction(makeArticle(), [], null);
    expect(result.action).toBe('CREATE');
    expect(result.bestMatch).toBeNull();
    expect(result.llmUsed).toBe(false);
  });

  it('returns LINK for high-similarity candidate', async () => {
    // Same vector = high embedding similarity + entity overlap
    const article = makeArticle({
      title: 'Reforma Pensional en Colombia',
      snippet: 'El Congreso de la República aprobó la reforma pensional de Gustavo Petro.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-match',
      articleVecs: [makeVec(42)], // identical vector
      articleTexts: ['Reforma Pensional en el Congreso de la República por Gustavo Petro'],
    });
    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('LINK');
    expect(result.bestMatch!.eventId).toBe('evt-match');
  });

  it('returns CREATE for distant candidate', async () => {
    const article = makeArticle({
      title: 'Economía del café en Colombia',
      snippet: 'Los cafeteros reportan pérdidas por el clima.',
      embeddingVec: makeVec(200),
    });
    const candidate = makeCandidate({
      id: 'evt-unrelated',
      articleVecs: [makeVec(50)],
      articleTexts: ['Fútbol colombiano: resultados de la liga'],
    });
    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('CREATE');
  });

  it('does not use LLM when llm is null', async () => {
    const result = await decideLinkAction(makeArticle(), [makeCandidate()], null);
    expect(result.llmUsed).toBe(false);
  });

  it('populates scores array', async () => {
    const result = await decideLinkAction(
      makeArticle(),
      [makeCandidate({ id: 'a' }), makeCandidate({ id: 'b' })],
      null,
    );
    expect(result.scores.length).toBe(2);
    for (const s of result.scores) {
      expect(s.embeddingSim).toBeGreaterThanOrEqual(0);
      expect(s.entityOverlap).toBeGreaterThanOrEqual(0);
      expect(s.temporalProximity).toBeGreaterThanOrEqual(0);
      expect(s.compositeScore).toBeGreaterThanOrEqual(0);
    }
  });
});
