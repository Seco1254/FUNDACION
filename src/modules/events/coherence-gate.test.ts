import { describe, it, expect } from 'vitest';
import {
  evaluateClusterCoherence,
  buildCoherenceGatePacket,
  checkEmbeddingCohesion,
  checkEntityOverlap,
  checkTitleAlignment,
  checkTopicDrift,
  THETA_EMBEDDING_COHESION,
  THETA_ENTITY_OVERLAP,
  THETA_TITLE_ALIGNMENT,
  THETA_TOPIC_DRIFT,
  type EventCluster,
  type ClusterArticle,
  type CoherenceGatePacket,
} from './coherence-gate.js';
import { computeEmbedding } from '../embedding/service/hash-vector.js';

// ── Helpers ─────────────────────────────────────────────────────────

/** Build a cluster article with embedding computed from title + text. */
function makeArticle(
  id: string,
  title: string,
  textNorm: string | null,
): ClusterArticle {
  const embeddingText = [title, textNorm ?? ''].join(' ');
  return {
    id,
    title,
    titleRaw: title,
    textNorm,
    embeddingVec: computeEmbedding(embeddingText),
  };
}

// ── Tests ───────────────────────────────────────────────────────────

describe('evaluateClusterCoherence', () => {
  it('auto-passes single-article clusters', () => {
    const cluster: EventCluster = {
      event_id: 'evt-1',
      headline: 'Reforma pensional',
      articles: [
        makeArticle('a1', 'Reforma pensional avanza en Colombia', 'El proyecto de reforma pensional avanzó en el Senado de Colombia'),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.failed_checks).toEqual([]);
  });

  it('auto-passes empty clusters', () => {
    const cluster: EventCluster = {
      event_id: 'evt-empty',
      headline: null,
      articles: [],
    };
    const result = evaluateClusterCoherence(cluster);
    expect(result.passed).toBe(true);
  });

  it('passes a coherent cluster about the same topic', () => {
    const cluster: EventCluster = {
      event_id: 'evt-coherent',
      headline: 'Reforma pensional aprobada en Colombia',
      articles: [
        makeArticle(
          'a1',
          'Reforma pensional aprobada en el Senado colombiano',
          'El Senado de Colombia aprobó la reforma pensional propuesta por el gobierno. La reforma modifica el sistema de pensiones y jubilación del país.',
        ),
        makeArticle(
          'a2',
          'Colombia aprueba reforma de pensiones en tercer debate',
          'La reforma pensional fue aprobada en tercer debate por el Congreso colombiano. El proyecto de ley cambia el sistema de pensiones para millones.',
        ),
        makeArticle(
          'a3',
          'Pensiones en Colombia: reforma avanza con mayoría en Senado',
          'Con mayoría de votos, el Senado colombiano avanzó la reforma de pensiones. Los cambios al sistema pensional entrarán en vigencia el próximo año.',
        ),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    expect(result.passed).toBe(true);
    expect(result.failed_checks.length).toBeLessThan(2);
  });

  it('blocks a cluster with 2 completely different topics', () => {
    const cluster: EventCluster = {
      event_id: 'evt-mixed',
      headline: 'Noticias del día en Colombia',
      articles: [
        makeArticle(
          'a1',
          'Terremoto de magnitud 6.5 sacude la costa pacífica de Colombia',
          'Un fuerte terremoto de magnitud 6.5 sacudió la costa pacífica colombiana dejando graves daños en infraestructura y varias personas heridas en Buenaventura.',
        ),
        makeArticle(
          'a2',
          'Selección Colombia clasifica al Mundial de fútbol 2026',
          'La selección colombiana de fútbol clasificó al Mundial 2026 tras derrotar a Paraguay con goles de Luis Díaz y James Rodríguez en el estadio Metropolitano de Barranquilla.',
        ),
        makeArticle(
          'a3',
          'Nuevo récord de exportaciones cafeteras colombianas',
          'Las exportaciones de café colombiano alcanzaron un récord histórico de mil millones de dólares en el primer trimestre según la Federación Nacional de Cafeteros.',
        ),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    expect(result.passed).toBe(false);
    expect(result.failed_checks.length).toBeGreaterThanOrEqual(2);
  });

  it('blocks a cluster with misaligned title', () => {
    const cluster: EventCluster = {
      event_id: 'evt-title-mismatch',
      headline: 'Elecciones presidenciales en Venezuela',
      articles: [
        makeArticle(
          'a1',
          'Precio del petróleo sube por tensiones en Medio Oriente',
          'El precio del barril de petróleo Brent subió a 95 dólares debido a las tensiones geopolíticas en Medio Oriente y los recortes de producción de la OPEP.',
        ),
        makeArticle(
          'a2',
          'OPEP decide recortar producción petrolera mundial',
          'La Organización de Países Exportadores de Petróleo decidió un recorte adicional de producción de crudo para estabilizar los precios internacionales del barril.',
        ),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    expect(result.failed_checks).toContain('title_content_mismatch');
  });
});

describe('metrics and thresholds persistence', () => {
  it('always returns metrics object with correct article_count', () => {
    const cluster: EventCluster = {
      event_id: 'evt-metrics',
      headline: 'Test headline',
      articles: [
        makeArticle('a1', 'Title A', 'Text A content here'),
        makeArticle('a2', 'Title B', 'Text B content here'),
        makeArticle('a3', 'Title C', 'Text C content here'),
      ],
    };
    const result = evaluateClusterCoherence(cluster);

    expect(result.metrics).toBeDefined();
    expect(result.metrics.article_count).toBe(3);
    expect(typeof result.metrics.avg_cosine).toBe('number');
    expect(typeof result.metrics.entity_jaccard).toBe('number');
    expect(typeof result.metrics.title_jaccard).toBe('number');
    expect(typeof result.metrics.stddev_drift).toBe('number');
  });

  it('always returns thresholds object matching current config', () => {
    const cluster: EventCluster = {
      event_id: 'evt-thresholds',
      headline: 'Test',
      articles: [
        makeArticle('a1', 'Title', 'Text'),
        makeArticle('a2', 'Title 2', 'Text 2'),
      ],
    };
    const result = evaluateClusterCoherence(cluster);

    expect(result.thresholds).toBeDefined();
    expect(result.thresholds.min_avg_cosine).toBe(THETA_EMBEDDING_COHESION);
    expect(result.thresholds.min_entity_jaccard).toBe(THETA_ENTITY_OVERLAP);
    expect(result.thresholds.min_title_jaccard).toBe(THETA_TITLE_ALIGNMENT);
    expect(result.thresholds.max_stddev_drift).toBe(THETA_TOPIC_DRIFT);
  });

  it('returns null avg_cosine and stddev_drift for single-article clusters', () => {
    const cluster: EventCluster = {
      event_id: 'evt-single',
      headline: 'Single article test',
      articles: [makeArticle('a1', 'Single article title', 'Some text content')],
    };
    const result = evaluateClusterCoherence(cluster);

    expect(result.metrics.avg_cosine).toBeNull();
    expect(result.metrics.stddev_drift).toBeNull();
    expect(result.metrics.entity_jaccard).toBeNull();
    expect(result.metrics.article_count).toBe(1);
    // title_jaccard can still be computed for single article with headline
    expect(result.metrics.title_jaccard).not.toBeNull();
  });

  it('returns all null metrics for empty cluster', () => {
    const cluster: EventCluster = {
      event_id: 'evt-zero',
      headline: null,
      articles: [],
    };
    const result = evaluateClusterCoherence(cluster);

    expect(result.metrics.avg_cosine).toBeNull();
    expect(result.metrics.entity_jaccard).toBeNull();
    expect(result.metrics.title_jaccard).toBeNull();
    expect(result.metrics.stddev_drift).toBeNull();
    expect(result.metrics.article_count).toBe(0);
  });

  it('returns null avg_cosine when articles have no embeddings', () => {
    const articles: ClusterArticle[] = [
      { id: 'a1', title: 'Test 1', textNorm: 'text', embeddingVec: null },
      { id: 'a2', title: 'Test 2', textNorm: 'text', embeddingVec: null },
    ];
    const cluster: EventCluster = {
      event_id: 'evt-no-emb',
      headline: 'Test',
      articles,
    };
    const result = evaluateClusterCoherence(cluster);

    expect(result.metrics.avg_cosine).toBeNull();
    expect(result.metrics.stddev_drift).toBeNull();
    // entity_jaccard and title_jaccard still computed from titles
    expect(result.metrics.entity_jaccard).not.toBeNull();
  });
});

describe('buildCoherenceGatePacket', () => {
  it('builds PASS packet with metrics and thresholds', () => {
    const cluster: EventCluster = {
      event_id: 'evt-packet-pass',
      headline: 'Test headline',
      articles: [
        makeArticle('a1', 'Reforma pensional Colombia aprobada', 'Reforma pensional aprobada en Colombia'),
        makeArticle('a2', 'Reforma pensional aprobada en Senado', 'El Senado aprobó la reforma pensional'),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    const packet = buildCoherenceGatePacket(result);

    expect(packet.status).toBe(result.passed ? 'PASS' : 'FAIL');
    expect(packet.failed_checks).toEqual(result.failed_checks);
    expect(packet.metrics).toEqual(result.metrics);
    expect(packet.thresholds).toEqual(result.thresholds);
    expect(packet.metrics.article_count).toBe(2);
  });

  it('builds FAIL packet with complete structure', () => {
    const cluster: EventCluster = {
      event_id: 'evt-packet-fail',
      headline: 'Elecciones presidenciales en Venezuela',
      articles: [
        makeArticle('a1', 'Terremoto sacude costa pacífica', 'Un fuerte terremoto sacudió la costa'),
        makeArticle('a2', 'Selección gana partido de fútbol', 'La selección ganó el partido eliminatorio'),
      ],
    };
    const result = evaluateClusterCoherence(cluster);
    const packet = buildCoherenceGatePacket(result);

    // Verify complete structure
    expect(packet).toHaveProperty('status');
    expect(packet).toHaveProperty('failed_checks');
    expect(packet).toHaveProperty('metrics');
    expect(packet).toHaveProperty('thresholds');
    expect(packet.metrics).toHaveProperty('avg_cosine');
    expect(packet.metrics).toHaveProperty('entity_jaccard');
    expect(packet.metrics).toHaveProperty('title_jaccard');
    expect(packet.metrics).toHaveProperty('stddev_drift');
    expect(packet.metrics).toHaveProperty('article_count');
    expect(packet.thresholds).toHaveProperty('min_avg_cosine');
    expect(packet.thresholds).toHaveProperty('min_entity_jaccard');
    expect(packet.thresholds).toHaveProperty('min_title_jaccard');
    expect(packet.thresholds).toHaveProperty('max_stddev_drift');
  });

  it('produces deterministic JSON structure', () => {
    const cluster: EventCluster = {
      event_id: 'evt-deterministic',
      headline: 'Test',
      articles: [
        makeArticle('a1', 'Title one', 'Text one'),
        makeArticle('a2', 'Title two', 'Text two'),
      ],
    };
    const result1 = evaluateClusterCoherence(cluster);
    const packet1 = buildCoherenceGatePacket(result1);
    const result2 = evaluateClusterCoherence(cluster);
    const packet2 = buildCoherenceGatePacket(result2);

    expect(JSON.stringify(packet1)).toBe(JSON.stringify(packet2));
  });
});

describe('checkEmbeddingCohesion', () => {
  it('returns score=1 and not failed for a single article', () => {
    const articles = [makeArticle('a1', 'Test', 'Some text')];
    const result = checkEmbeddingCohesion(articles);
    expect(result.score).toBe(1);
    expect(result.failed).toBe(false);
  });

  it('returns high score for similar articles', () => {
    const articles = [
      makeArticle('a1', 'Reforma pensional Colombia', 'Reforma de pensiones aprobada en el Senado colombiano'),
      makeArticle('a2', 'Reforma pensional aprobada', 'La reforma de pensiones fue aprobada en Colombia por el Senado'),
    ];
    const result = checkEmbeddingCohesion(articles);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('returns low score for dissimilar articles', () => {
    const articles = [
      makeArticle('a1', 'Terremoto sacude costa pacífica colombiana', 'Un fuerte terremoto sacudió la costa pacífica dejando graves daños en Buenaventura'),
      makeArticle('a2', 'Selección Colombia gana partido eliminatorias', 'La selección colombiana ganó su partido de las eliminatorias mundialistas con goles de Luis Díaz'),
    ];
    const result = checkEmbeddingCohesion(articles);
    expect(result.score).toBeLessThan(0.9);
  });

  it('handles articles without embeddings gracefully', () => {
    const articles: ClusterArticle[] = [
      { id: 'a1', title: 'Test 1', textNorm: 'text', embeddingVec: null },
      { id: 'a2', title: 'Test 2', textNorm: 'text', embeddingVec: null },
    ];
    const result = checkEmbeddingCohesion(articles);
    expect(result.score).toBe(1);
    expect(result.failed).toBe(false);
  });
});

describe('checkEntityOverlap', () => {
  it('returns high overlap for same entities', () => {
    const articles = [
      makeArticle('a1', 'Petro anuncia reforma en Bogotá', null),
      makeArticle('a2', 'Petro presenta reforma desde Bogotá', null),
    ];
    const result = checkEntityOverlap(articles);
    expect(result.score).toBeGreaterThan(0.05);
    expect(result.failed).toBe(false);
  });

  it('returns zero overlap for completely different entities', () => {
    const articles = [
      makeArticle('a1', 'Biden visita Kiev en apoyo a Ucrania', null),
      makeArticle('a2', 'Petro anuncia reforma en Bogotá', null),
    ];
    const result = checkEntityOverlap(articles);
    expect(result.score).toBe(0);
    expect(result.failed).toBe(true);
  });

  it('auto-passes single article', () => {
    const articles = [makeArticle('a1', 'Test title', null)];
    const result = checkEntityOverlap(articles);
    expect(result.score).toBe(1);
    expect(result.failed).toBe(false);
  });
});

describe('checkTitleAlignment', () => {
  it('returns high alignment when headline matches articles', () => {
    const articles = [
      makeArticle('a1', 'Reforma pensional aprobada en Senado', 'La reforma pensional fue aprobada por el Senado colombiano'),
      makeArticle('a2', 'Senado aprueba reforma de pensiones', 'El Senado de Colombia aprobó la reforma de las pensiones'),
    ];
    const result = checkTitleAlignment('Reforma pensional aprobada en Colombia', articles);
    expect(result.score).toBeGreaterThan(0.15);
    expect(result.failed).toBe(false);
  });

  it('returns low alignment when headline is unrelated', () => {
    const articles = [
      makeArticle('a1', 'Terremoto sacude costa pacífica', 'Un fuerte terremoto sacudió la costa pacífica colombiana'),
      makeArticle('a2', 'Sismo deja daños en Buenaventura', 'El sismo causó graves daños en la ciudad de Buenaventura'),
    ];
    const result = checkTitleAlignment('Elecciones presidenciales Venezuela', articles);
    expect(result.failed).toBe(true);
  });

  it('auto-passes when headline is null', () => {
    const articles = [makeArticle('a1', 'Test', 'text')];
    const result = checkTitleAlignment(null, articles);
    expect(result.score).toBe(1);
    expect(result.failed).toBe(false);
  });
});

describe('checkTopicDrift', () => {
  it('returns low drift for coherent articles', () => {
    const articles = [
      makeArticle('a1', 'Reforma pensional Colombia', 'Reforma de pensiones aprobada'),
      makeArticle('a2', 'Reforma pensional aprobada', 'La reforma de pensiones colombiana'),
      makeArticle('a3', 'Pensiones Colombia reforma', 'El sistema de pensiones será reformado'),
    ];
    const result = checkTopicDrift(articles);
    expect(result.score).toBeLessThan(0.35);
    expect(result.failed).toBe(false);
  });

  it('returns high drift for mixed topics', () => {
    const articles = [
      makeArticle('a1', 'Terremoto sacude costa pacífica colombiana', 'Un fuerte terremoto de magnitud 6.5 sacudió la costa pacífica con graves daños'),
      makeArticle('a2', 'Selección Colombia gana Mundial fútbol', 'La selección colombiana ganó el partido del mundial con goles de Luis Díaz'),
      makeArticle('a3', 'Exportaciones café colombiano récord', 'Las exportaciones de café colombiano alcanzaron récord según la Federación de Cafeteros'),
    ];
    const result = checkTopicDrift(articles);
    expect(result.score).toBeGreaterThan(0);
  });

  it('auto-passes for single article', () => {
    const articles = [makeArticle('a1', 'Test', 'text')];
    const result = checkTopicDrift(articles);
    expect(result.score).toBe(0);
    expect(result.failed).toBe(false);
  });
});
