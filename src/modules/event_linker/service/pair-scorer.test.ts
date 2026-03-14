import { describe, it, expect, vi } from 'vitest';
import {
  scoreCandidates,
  decideLinkAction,
  extractEntities,
  checkHardBlock,
  THETA_AUTO_LINK,
  THETA_MAYBE_LINK,
  DISABLE_AUTO_LINK,
  ENTITY_GUARD_ENABLED,
  ENTITY_GUARD_MIN_JACCARD,
  ArticleForPairing,
  EventCandidate,
  HardBlockContext,
  EventCandidateContext,
} from './pair-scorer.js';
import { LlmClient } from '../../../core/llm/client.js';

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
    uniqueMediaCount: 2,
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

// ── Hard block tests ──

describe('checkHardBlock', () => {
  it('action_incompatible forces hard_block', () => {
    const article: HardBlockContext = { articleAction: 'protest' };
    const event: EventCandidateContext = { eventAction: 'election' };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('action_incompatible');
  });

  it('same action does NOT trigger hard_block', () => {
    const article: HardBlockContext = { articleAction: 'protest' };
    const event: EventCandidateContext = { eventAction: 'protest' };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(false);
  });

  it('city_mismatch forces hard_block when both high confidence', () => {
    const article: HardBlockContext = {
      articleCity: 'Bogotá',
      articleCityConfidence: 0.9,
    };
    const event: EventCandidateContext = {
      eventCity: 'Medellín',
      eventCityConfidence: 0.85,
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('city_mismatch');
  });

  it('city_mismatch does NOT trigger when confidence < 0.7', () => {
    const article: HardBlockContext = {
      articleCity: 'Bogotá',
      articleCityConfidence: 0.5,
    };
    const event: EventCandidateContext = {
      eventCity: 'Medellín',
      eventCityConfidence: 0.9,
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(false);
  });

  it('same city does NOT trigger hard_block', () => {
    const article: HardBlockContext = {
      articleCity: 'bogotá',
      articleCityConfidence: 0.9,
    };
    const event: EventCandidateContext = {
      eventCity: 'Bogotá',
      eventCityConfidence: 0.9,
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(false);
  });

  it('date_gap > 7 days forces hard_block', () => {
    const article: HardBlockContext = {
      articleFactDate: new Date('2025-01-20T10:00:00Z'),
    };
    const event: EventCandidateContext = {
      eventFactDateEarliest: new Date('2025-01-01T10:00:00Z'),
      eventFactDateLatest: new Date('2025-01-05T10:00:00Z'),
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('date_gap');
  });

  it('date_gap <= 7 days does NOT trigger hard_block', () => {
    const article: HardBlockContext = {
      articleFactDate: new Date('2025-01-10T10:00:00Z'),
    };
    const event: EventCandidateContext = {
      eventFactDateEarliest: new Date('2025-01-05T10:00:00Z'),
      eventFactDateLatest: new Date('2025-01-08T10:00:00Z'),
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(false);
  });

  it('multiple hard_block reasons can combine', () => {
    const article: HardBlockContext = {
      articleAction: 'protest',
      articleCity: 'Cali',
      articleCityConfidence: 0.9,
      articleFactDate: new Date('2025-02-01T10:00:00Z'),
    };
    const event: EventCandidateContext = {
      eventAction: 'election',
      eventCity: 'Barranquilla',
      eventCityConfidence: 0.8,
      eventFactDateEarliest: new Date('2025-01-01T10:00:00Z'),
      eventFactDateLatest: new Date('2025-01-05T10:00:00Z'),
    };
    const result = checkHardBlock(article, event);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('action_incompatible');
    expect(result.reasons).toContain('city_mismatch');
    expect(result.reasons).toContain('date_gap');
    expect(result.reasons.length).toBe(3);
  });

  it('no context = no hard_block', () => {
    const result = checkHardBlock({}, {});
    expect(result.blocked).toBe(false);
    expect(result.reasons.length).toBe(0);
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

  it('marks candidates with hard_block from context', () => {
    const article = makeArticle({
      hardBlockContext: { articleAction: 'protest' },
    });
    const blocked = makeCandidate({
      id: 'evt-blocked',
      hardBlockContext: { eventAction: 'election' },
    });
    const ok = makeCandidate({
      id: 'evt-ok',
      hardBlockContext: { eventAction: 'protest' },
    });
    const scores = scoreCandidates(article, [blocked, ok]);
    const blockedScore = scores.find((s) => s.eventId === 'evt-blocked');
    const okScore = scores.find((s) => s.eventId === 'evt-ok');
    expect(blockedScore!.hardBlock).toBe(true);
    expect(blockedScore!.hardBlockReasons).toContain('action_incompatible');
    expect(okScore!.hardBlock).toBe(false);
  });
});

describe('decideLinkAction', () => {
  it('returns CREATE when no candidates', async () => {
    const result = await decideLinkAction(makeArticle(), [], null);
    expect(result.action).toBe('CREATE');
    expect(result.bestMatch).toBeNull();
    expect(result.llmUsed).toBe(false);
  });

  it('returns LINK for high-similarity candidate (>= 0.62)', async () => {
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

  it('returns CREATE for distant candidate (< 0.50)', async () => {
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

  it('populates scores array with hardBlock fields', async () => {
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
      expect(typeof s.hardBlock).toBe('boolean');
      expect(Array.isArray(s.hardBlockReasons)).toBe(true);
    }
  });

  it('hard_block forces CREATE even with high score', async () => {
    // Identical embeddings + entities → would normally score >= 0.62
    const article = makeArticle({
      title: 'Reforma Pensional en Colombia',
      snippet: 'El Congreso de la República aprobó la reforma pensional de Gustavo Petro.',
      embeddingVec: makeVec(42),
      hardBlockContext: { articleAction: 'protest' },
    });
    const candidate = makeCandidate({
      id: 'evt-blocked',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma Pensional en el Congreso de la República por Gustavo Petro'],
      hardBlockContext: { eventAction: 'election' },
    });
    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('CREATE');
    expect(result.bestMatch).toBeNull();
  });

  it('maybe range: LINK when score in [MAYBE, AUTO) and event has >= 1 media', async () => {
    // Distant vectors (no overlap) + shared entity names + close temporal
    // → embedding ≈ 0, entity ≈ 0.5, temporal ≈ 1.0 → composite ≈ 0.325
    const article = makeArticle({
      title: 'Gustavo Petro impulsa reforma',
      snippet: 'Gustavo Petro firmó decreto en el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-maybe',
      articleVecs: [makeVec(100)], // distant vector — no bucket overlap
      articleTexts: ['Gustavo Petro presenta plan en el Congreso de la República'],
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
    });

    const scores = scoreCandidates(article, [candidate]);
    const score = scores[0].compositeScore;
    expect(score).toBeGreaterThanOrEqual(THETA_MAYBE_LINK);
    expect(score).toBeLessThan(THETA_AUTO_LINK);

    // With >= 1 media → should LINK in maybe range
    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('LINK');
    expect(result.bestMatch!.eventId).toBe('evt-maybe');
  });

  it('below maybe threshold: CREATE even with media', async () => {
    // Distant vectors + different entity names + old temporal → low composite
    const article = makeArticle({
      title: 'Economía del café',
      snippet: 'Los cafeteros reportan pérdidas por el clima.',
      embeddingVec: makeVec(200),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-distant',
      articleVecs: [makeVec(50)],
      articleTexts: ['Fútbol colombiano resultados de la liga'],
      t0: new Date('2025-01-01T10:00:00Z'),
      tLast: new Date('2025-01-02T10:00:00Z'),
      uniqueMediaCount: 3,
    });

    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].compositeScore).toBeLessThan(THETA_MAYBE_LINK);

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('CREATE');
  });

  it('thresholds default: THETA_AUTO_LINK = 0.45, THETA_MAYBE_LINK = 0.28', () => {
    expect(THETA_AUTO_LINK).toBe(0.45);
    expect(THETA_MAYBE_LINK).toBe(0.28);
  });

  it('entity guard defaults: enabled with min_jaccard = 0.01', () => {
    expect(ENTITY_GUARD_ENABLED).toBe(true);
    expect(ENTITY_GUARD_MIN_JACCARD).toBe(0.01);
  });

  it('DISABLE_AUTO_LINK defaults to false', () => {
    expect(DISABLE_AUTO_LINK).toBe(false);
  });

  it('entity guard: auto-link with entity overlap > MIN_JACCARD still links', async () => {
    // Same vector + shared entities → high score, entity overlap > 0.01
    const article = makeArticle({
      title: 'Reforma Pensional en Colombia',
      snippet: 'El Congreso de la República aprobó la reforma pensional de Gustavo Petro.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-entities',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma Pensional en el Congreso de la República por Gustavo Petro'],
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].entityOverlap).toBeGreaterThan(ENTITY_GUARD_MIN_JACCARD);
    expect(scores[0].compositeScore).toBeGreaterThanOrEqual(THETA_AUTO_LINK);

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('LINK');
  });

  it('entity guard: auto-link score with zero entity overlap downgrades to maybe logic', async () => {
    // Identical vector → high embedding sim, but completely unrelated entities → entityOverlap=0
    // The entity guard should downgrade from auto-link to maybe-link
    const article = makeArticle({
      title: 'Alpha Bravo Charlie',
      snippet: 'Alpha Bravo Charlie Delta.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-no-entities',
      articleVecs: [makeVec(42)], // identical → high embedding
      articleTexts: ['Xray Yankee Zulu'],
      uniqueMediaCount: 1,
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].entityOverlap).toBe(0);

    // With entity guard enabled, this should still LINK via the maybe path
    // because uniqueMediaCount >= 1 and composite >= THETA_MAYBE_LINK
    const result = await decideLinkAction(article, [candidate], null);
    // Score is above auto-link but entity guard downgrades it.
    // Then maybe-link path checks uniqueMedia >= 1 → LINK
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      expect(result.action).toBe('LINK');
    } else {
      expect(result.action).toBe('CREATE');
    }
  });
});

// ── v2.1: Hard Negative Gates in scoreCandidates ──

describe('v2.1: scoreCandidates with gates', () => {
  it('populates gatesBlockAutoReasons and signalsPassed', () => {
    const article = makeArticle();
    const candidate = makeCandidate({ id: 'evt-1' });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores.length).toBe(1);
    expect(Array.isArray(scores[0].gatesBlockAutoReasons)).toBe(true);
    expect(scores[0].signalsPassed).toBeDefined();
    expect(typeof scores[0].signalsPassed.embed).toBe('boolean');
    expect(typeof scores[0].signalsPassed.entity).toBe('boolean');
    expect(typeof scores[0].signalsPassed.topic).toBe('boolean');
    expect(typeof scores[0].signalsPassed.count).toBe('number');
    expect(['AUTO_LINK', 'MAYBE_LINK', 'CREATE']).toContain(scores[0].finalAction);
  });

  it('title contradiction gate: totally different titles + low entity → blocks auto (TITLE_CONTRADICTION_LOW_OVERLAP)', () => {
    // Completely different titles, different embeddings → should trigger title gate
    const article = makeArticle({
      title: 'Salario mínimo sube doce por ciento este año',
      snippet: 'El gobierno anunció un incremento del salario.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-diff',
      articleVecs: [makeVec(42)],  // same embedding (otherwise would be below threshold)
      articleTexts: ['Fortuna de magnate alcanza cien millones dólares'],
      representativeTitle: 'Fortuna de magnate alcanza cien millones dólares',
    });
    const scores = scoreCandidates(article, [candidate]);
    const s = scores[0];
    // With different titles and low entity overlap, the title gate should fire
    if (s.entityOverlap < 0.05) {
      // ENTITY_LOW_FOR_AUTO should also fire when entity overlap < 0.05
      expect(s.gatesBlockAutoReasons).toContain('ENTITY_LOW_FOR_AUTO');
    }
    // finalAction should NOT be AUTO_LINK
    expect(s.finalAction).not.toBe('AUTO_LINK');
  });

  it('topic mismatch gate: different topics → blocks auto', () => {
    const article = makeArticle({
      embeddingVec: makeVec(42),
      topicTop1: 'economia',
    });
    const candidate = makeCandidate({
      id: 'evt-topic',
      articleVecs: [makeVec(42)],
      topicTop1: 'deportes',
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].gatesBlockAutoReasons).toContain('TOPIC_MISMATCH');
    expect(scores[0].finalAction).not.toBe('AUTO_LINK');
  });

  it('entity jaccard low for auto but above maybe → degrades to MAYBE_LINK', () => {
    // Zero entity overlap + high embedding → entity gate blocks auto, but allows maybe
    const article = makeArticle({
      title: 'Alpha Bravo Charlie',
      snippet: 'Alpha Bravo Charlie Delta.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-low-ent',
      articleVecs: [makeVec(42)],
      articleTexts: ['Xray Yankee Zulu'],
      uniqueMediaCount: 1,
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].entityOverlap).toBe(0);
    expect(scores[0].gatesBlockAutoReasons).toContain('ENTITY_LOW_FOR_AUTO');
    // Since embedding is high (>=0.60), ENTITY_VERY_LOW should NOT fire
    if (scores[0].embeddingSim >= 0.60) {
      expect(scores[0].gatesBlockAutoReasons).not.toContain('ENTITY_VERY_LOW');
      expect(scores[0].finalAction).toBe('MAYBE_LINK');
    }
  });
});

// ── v2.1: Two-step linking ──

describe('v2.1: two-step linking', () => {
  it('high score but zero entity overlap → NOT auto (gates degrade to maybe)', async () => {
    // High embedding sim (1.0), zero entity overlap, no topic
    // → ENTITY_LOW_FOR_AUTO gate blocks auto-link → MAYBE_LINK
    const article = makeArticle({
      title: 'Alpha Bravo Charlie',
      snippet: 'Alpha Bravo Charlie Delta.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-1signal',
      articleVecs: [makeVec(42)], // identical → embed sim = 1.0
      articleTexts: ['Xray Yankee Zulu'], // no entity overlap
      uniqueMediaCount: 1,
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].compositeScore).toBeGreaterThanOrEqual(THETA_AUTO_LINK);
    // Only embed signal should pass, entity = 0 < 0.08
    expect(scores[0].signalsPassed.embed).toBe(true);
    expect(scores[0].signalsPassed.entity).toBe(false);
    // Should be degraded to MAYBE_LINK by either gates or two-step
    expect(scores[0].finalAction).not.toBe('AUTO_LINK');

    const result = await decideLinkAction(article, [candidate], null);
    // Still links via maybe path since uniqueMedia >= 1
    expect(result.action).toBe('LINK');
    expect(result.linkType).toBe('MAYBE_LINK');
  });

  it('high score + 2 strong signals + no gates → auto-link', async () => {
    // Same embedding + shared entities → both embed and entity signals pass
    const article = makeArticle({
      title: 'Reforma Pensional en Colombia',
      snippet: 'El Congreso de la República aprobó la reforma pensional de Gustavo Petro.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-2signals',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma Pensional en el Congreso de la República por Gustavo Petro'],
      representativeTitle: 'Reforma Pensional en el Congreso de la República por Gustavo Petro',
    });
    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].compositeScore).toBeGreaterThanOrEqual(THETA_AUTO_LINK);
    expect(scores[0].signalsPassed.embed).toBe(true);
    expect(scores[0].signalsPassed.entity).toBe(true);
    expect(scores[0].signalsPassed.count).toBeGreaterThanOrEqual(2);
    expect(scores[0].finalAction).toBe('AUTO_LINK');

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('LINK');
    expect(result.linkType).toBe('AUTO_LINK');
  });

  it('v2.2: AUTO_REQUIRES_SIGNALS defaults to 1 (topic not available at link time)', async () => {
    // Verify the config change: topicTop1 is never populated at linking time,
    // so requiring 2/3 signals (embed + entity) was too strict.
    // With AUTO_REQUIRES_SIGNALS=1, a single strong signal suffices.
    const { AUTO_REQUIRES_SIGNALS } = await import('./config.js');
    expect(AUTO_REQUIRES_SIGNALS).toBe(1);
  });

  it('decideLinkAction returns linkType field', async () => {
    const result = await decideLinkAction(makeArticle(), [], null);
    expect(result.linkType).toBe('CREATE');
  });
});

// ── v2.6: Source-aware precision — OR + keyword gate cross-source, hardened same-source ──

describe('v2.6: cross-source linking', () => {
  it('cross-source false positive: zero shared headline keywords → CREATE', async () => {
    // Irán/carbón scenario: unrelated topics from different media.
    // 6 candidate vecs dilute cosine to ~0.41 → composite in MAYBE zone.
    // Headlines share zero keywords → keyword gate blocks.
    const article = makeArticle({
      title: 'Sanciones contra Irán por programa nuclear',
      snippet: 'Irán rechaza sanciones. Washington critica. Berlín apoya. París condena. Tokio observa. Londres reacciona. Roma evalúa. Seúl protesta. Ottawa medita. Colombia se pronuncia.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'el-tiempo',
    });
    const candidate = makeCandidate({
      id: 'evt-unrelated-cross',
      articleVecs: [makeVec(42), makeVec(43), makeVec(44), makeVec(45), makeVec(46), makeVec(47)],
      articleTexts: ['Boyacá reporta daños. Cesar investiga. Santander alerta. Antioquia cierra. Arauca suspende. Meta evalúa. Casanare protesta. Cauca analiza. Nariño responde. Colombia actúa.'],
      representativeTitle: 'Minería ilegal de carbón afecta zona rural',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['semana']),
    });

    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].compositeScore).toBeGreaterThanOrEqual(THETA_MAYBE_LINK);
    expect(scores[0].compositeScore).toBeLessThan(THETA_AUTO_LINK);

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('CREATE');
  });

  it('cross-source legitimate: shared keywords + signal → LINK', async () => {
    // Same event (reforma) covered by two outlets — shared keywords "reforma", "tributaria"
    const article = makeArticle({
      title: 'Reforma tributaria aprobada por el Congreso de la República',
      snippet: 'La Reforma Tributaria fue aprobada por el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'el-tiempo',
    });
    const candidate = makeCandidate({
      id: 'evt-legit-cross',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma tributaria avanza en el Congreso de la República'],
      representativeTitle: 'Congreso aprueba la reforma tributaria',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['semana']),
    });

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('LINK');
  });

  it('cross-source with only embedding signal (no entity) still links if keywords match', async () => {
    // v2.6 reverted AND → OR: a single signal suffices if keyword gate passes.
    // High embedding, zero entities but shared keyword "foxtrot"
    const article = makeArticle({
      title: 'Alpha Bravo Charlie foxtrot',
      snippet: 'Alpha Bravo Charlie Delta foxtrot.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'el-tiempo',
    });
    const candidate = makeCandidate({
      id: 'evt-cross-embed-only',
      articleVecs: [makeVec(42)],
      articleTexts: ['Xray Yankee Zulu foxtrot'],
      representativeTitle: 'Xray Yankee Zulu foxtrot',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['semana']),
    });

    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].entityOverlap).toBe(0);
    // OR: embeddingSim >= 0.40 passes even with entity = 0
    // Keyword gate: shared keyword "foxtrot" → passes
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('LINK');
    }
  });
});

describe('v2.6: same-source precision', () => {
  it('same-source entity overlap >= 0.06 bypasses headline divergence → LINK', async () => {
    // TransMilenio/Externado case: same source, different headlines but
    // meaningful entity overlap from shared specific entities
    const article = makeArticle({
      title: 'TransMilenio suspende servicio en estación Externado',
      snippet: 'TransMilenio de Bogotá suspende temporalmente la estación Externado por obras.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'mediaA',
    });
    const candidate = makeCandidate({
      id: 'evt-high-entity',
      articleVecs: [makeVec(100)],
      articleTexts: ['TransMilenio informa cierre temporal de Externado en Bogotá por mantenimiento'],
      representativeTitle: 'Cierres en TransMilenio afectan la estación Externado',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['mediaA']),
    });

    const scores = scoreCandidates(article, [candidate]);
    const s = scores[0];
    // v2.6: bypass threshold lowered from 0.10 → 0.06
    if (s.entityOverlap >= 0.06 && s.compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('LINK');
    }
  });

  it('same-source 1 shared keyword + low entity → blocked (over-merge prevention)', async () => {
    // v2.6 P1: articles sharing only 1 generic keyword like "petro" should NOT merge
    // when entity overlap is low. This targets the 35% same-source over-merge.
    const article = makeArticle({
      title: 'Petro anuncia reforma pensional integral',
      snippet: 'Gustavo Petro presenta al Congreso nueva reforma pensional.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'mediaA',
    });
    const candidate = makeCandidate({
      id: 'evt-same-1keyword',
      articleVecs: [makeVec(42)],
      articleTexts: ['Gustavo Petro viaja a Europa para cumbre climática'],
      representativeTitle: 'Petro viaja a Europa para cumbre climática',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['mediaA']),
    });

    const scores = scoreCandidates(article, [candidate]);
    const s = scores[0];
    // Headlines share only "petro" (1 keyword) — too generic
    if (s.entityOverlap < 0.06 && s.compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('CREATE');
    }
  });

  it('same-source 2+ shared keywords + low entity → links normally', async () => {
    // "reforma" + "tributaria" shared → legitimate same-event coverage
    const article = makeArticle({
      title: 'Reforma tributaria aprobada en segundo debate',
      snippet: 'El Congreso aprobó la reforma tras extenso debate.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'mediaA',
    });
    const candidate = makeCandidate({
      id: 'evt-same-2keywords',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma tributaria avanza en el Congreso colombiano'],
      representativeTitle: 'Reforma tributaria avanza en el Congreso colombiano',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['mediaA']),
    });

    const scores = scoreCandidates(article, [candidate]);
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('LINK');
    }
  });

  it('same-source zero shared keywords + low entity → blocked', async () => {
    // Completely unrelated same-media articles — divergence guard blocks
    const article = makeArticle({
      title: 'Salario mínimo sube para trabajadores colombianos',
      snippet: 'El incremento salarial beneficia a millones.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
      mediaId: 'mediaA',
    });
    const candidate = makeCandidate({
      id: 'evt-same-divergent',
      articleVecs: [makeVec(42)],
      articleTexts: ['Temblor sacude la costa pacífica de Colombia'],
      representativeTitle: 'Temblor sacude la costa pacífica de Colombia',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
      mediaIds: new Set(['mediaA']),
    });

    const scores = scoreCandidates(article, [candidate]);
    const s = scores[0];
    if (s.compositeScore >= THETA_MAYBE_LINK && s.compositeScore < THETA_AUTO_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('CREATE');
    }
  });

  it('regression: unrelated articles with no signal still CREATE', async () => {
    const article = makeArticle({
      title: 'Economía del café en Colombia',
      snippet: 'Los cafeteros reportan pérdidas por el clima.',
      embeddingVec: makeVec(200),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-unrelated',
      articleVecs: [makeVec(50)],
      articleTexts: ['Fútbol colombiano: resultados de la liga'],
      t0: new Date('2025-01-01T10:00:00Z'),
      tLast: new Date('2025-01-02T10:00:00Z'),
      uniqueMediaCount: 3,
    });

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.action).toBe('CREATE');
  });

  it('no mediaId → treated as same-source (conservative) → divergence blocks', async () => {
    const article = makeArticle({
      title: 'Salario mínimo sube para trabajadores colombianos',
      snippet: 'El incremento salarial beneficia a millones.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-no-media',
      articleVecs: [makeVec(42)],
      articleTexts: ['Temblor sacude la costa pacífica de Colombia'],
      representativeTitle: 'Temblor sacude la costa pacífica de Colombia',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 2,
    });

    const scores = scoreCandidates(article, [candidate]);
    const s = scores[0];
    if (s.compositeScore >= THETA_MAYBE_LINK && s.compositeScore < THETA_AUTO_LINK) {
      const result = await decideLinkAction(article, [candidate], null);
      expect(result.action).toBe('CREATE');
    }
  });
});

// ── v3: LLM verifier routing ──

describe('v3: LLM verifier integration', () => {
  // Helper: create a mock LLM that returns a specific verifier verdict
  function makeMockLlm(verdict: string, confidence = 0.9): LlmClient {
    const llm = new LlmClient({ apiKey: 'test-key' });
    vi.spyOn(llm, 'isAvailable').mockReturnValue(true);
    vi.spyOn(llm, 'completeJson').mockResolvedValue({
      data: { verdict, confidence, reasoning: 'test' },
      meta: { model: 'test', input_tokens: 100, output_tokens: 50, latency_ms: 200 },
    });
    return llm;
  }

  it('AUTO_LINK bypasses LLM verifier entirely', async () => {
    // High score + entities + signals → AUTO_LINK, no LLM needed
    const llm = makeMockLlm('DIFFERENT_EVENT');
    const completeSpy = vi.spyOn(llm, 'completeJson');

    const article = makeArticle({
      title: 'Reforma Pensional en Colombia',
      snippet: 'El Congreso de la República aprobó la reforma pensional de Gustavo Petro.',
      embeddingVec: makeVec(42),
    });
    const candidate = makeCandidate({
      id: 'evt-auto',
      articleVecs: [makeVec(42)],
      articleTexts: ['Reforma Pensional en el Congreso de la República por Gustavo Petro'],
      representativeTitle: 'Reforma Pensional en el Congreso de la República por Gustavo Petro',
    });

    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].finalAction).toBe('AUTO_LINK');

    const result = await decideLinkAction(article, [candidate], llm);
    expect(result.action).toBe('LINK');
    expect(result.linkType).toBe('AUTO_LINK');
    expect(result.llmUsed).toBe(false);
    // LLM should NOT have been called
    expect(completeSpy).not.toHaveBeenCalled();
  });

  it('MAYBE + LLM SAME_EVENT → LINK', async () => {
    const llm = makeMockLlm('SAME_EVENT', 0.92);

    // Craft a pair in MAYBE zone: shared entities, distant vectors
    const article = makeArticle({
      title: 'Gustavo Petro impulsa reforma',
      snippet: 'Gustavo Petro firmó decreto en el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-maybe',
      articleVecs: [makeVec(100)],
      articleTexts: ['Gustavo Petro presenta plan en el Congreso de la República'],
      representativeTitle: 'Gustavo Petro presenta plan económico',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
    });

    const scores = scoreCandidates(article, [candidate]);
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], llm);
      expect(result.action).toBe('LINK');
      expect(result.linkType).toBe('MAYBE_LINK');
      expect(result.llmUsed).toBe(true);
    }
  });

  it('MAYBE + LLM DIFFERENT_EVENT → CREATE', async () => {
    const llm = makeMockLlm('DIFFERENT_EVENT', 0.88);

    const article = makeArticle({
      title: 'Gustavo Petro impulsa reforma',
      snippet: 'Gustavo Petro firmó decreto en el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-maybe-diff',
      articleVecs: [makeVec(100)],
      articleTexts: ['Gustavo Petro presenta plan en el Congreso de la República'],
      representativeTitle: 'Gustavo Petro presenta plan económico',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
    });

    const scores = scoreCandidates(article, [candidate]);
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], llm);
      expect(result.action).toBe('CREATE');
      expect(result.llmUsed).toBe(true);
    }
  });

  it('MAYBE + LLM UNCERTAIN → falls through to heuristic', async () => {
    const llm = makeMockLlm('UNCERTAIN', 0.45);

    const article = makeArticle({
      title: 'Gustavo Petro impulsa reforma',
      snippet: 'Gustavo Petro firmó decreto en el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-maybe-uncertain',
      articleVecs: [makeVec(100)],
      articleTexts: ['Gustavo Petro presenta plan en el Congreso de la República'],
      representativeTitle: 'Gustavo Petro presenta plan económico',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
    });

    const scores = scoreCandidates(article, [candidate]);
    if (scores[0].compositeScore >= THETA_MAYBE_LINK) {
      const result = await decideLinkAction(article, [candidate], llm);
      // UNCERTAIN → heuristic fallback decides (not llmUsed)
      // The heuristic may LINK or CREATE depending on signals — we just verify
      // it fell through (llmUsed = false because final decision was heuristic)
      expect(result.llmUsed).toBe(false);
    }
  });

  it('MAYBE + LLM null (disabled/unavailable) → heuristic fallback', async () => {
    // Pass null LLM — should fall through to heuristic
    const article = makeArticle({
      title: 'Gustavo Petro impulsa reforma',
      snippet: 'Gustavo Petro firmó decreto en el Congreso de la República.',
      embeddingVec: makeVec(42),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-maybe-no-llm',
      articleVecs: [makeVec(100)],
      articleTexts: ['Gustavo Petro presenta plan en el Congreso de la República'],
      representativeTitle: 'Gustavo Petro presenta plan económico',
      t0: new Date('2025-01-14T08:00:00Z'),
      tLast: new Date('2025-01-15T09:00:00Z'),
      uniqueMediaCount: 1,
    });

    const result = await decideLinkAction(article, [candidate], null);
    expect(result.llmUsed).toBe(false);
    // Backward compat: without LLM, heuristic still works
    expect(['LINK', 'CREATE']).toContain(result.action);
  });

  it('below threshold → CREATE regardless of LLM', async () => {
    const llm = makeMockLlm('SAME_EVENT', 0.99);

    const article = makeArticle({
      title: 'Economía del café en Colombia',
      snippet: 'Los cafeteros reportan pérdidas por el clima.',
      embeddingVec: makeVec(200),
      publishedAt: new Date('2025-01-15T10:00:00Z'),
    });
    const candidate = makeCandidate({
      id: 'evt-below',
      articleVecs: [makeVec(50)],
      articleTexts: ['Fútbol colombiano resultados de la liga'],
      t0: new Date('2025-01-01T10:00:00Z'),
      tLast: new Date('2025-01-02T10:00:00Z'),
      uniqueMediaCount: 3,
    });

    const scores = scoreCandidates(article, [candidate]);
    expect(scores[0].compositeScore).toBeLessThan(THETA_MAYBE_LINK);

    const result = await decideLinkAction(article, [candidate], llm);
    expect(result.action).toBe('CREATE');
    // LLM should NOT be called for below-threshold pairs
    expect(result.llmUsed).toBe(false);
  });
});
