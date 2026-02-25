import { describe, it, expect } from 'vitest';
import {
  evaluateClusterCoherence,
  checkEmbeddingCohesion,
  checkEntityOverlap,
  checkTitleAlignment,
  checkTopicDrift,
  type EventCluster,
  type ClusterArticle,
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
    // title_content_mismatch should be among failed checks
    expect(result.failed_checks).toContain('title_content_mismatch');
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
