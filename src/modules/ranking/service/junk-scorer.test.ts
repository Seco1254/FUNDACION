import { describe, it, expect } from 'vitest';
import {
  computeJunkScore,
  JUNK_EXCLUDE_THRESHOLD,
  JUNK_PENALTY_THRESHOLD,
  JunkSignals,
} from './junk-scorer.js';

describe('computeJunkScore', () => {
  const normalArticle: JunkSignals = {
    url: 'https://razonpublica.com/reforma-pensional-2024',
    title: 'La reforma pensional avanza en el Congreso',
    snippet: 'El proyecto de ley que busca modificar el sistema de pensiones en Colombia recibió su primer debate en la Cámara de Representantes. La iniciativa propone cambios significativos en la distribución de aportes entre los pilares público y privado.',
  };

  it('scores a normal news article near zero', () => {
    const result = computeJunkScore(normalArticle);
    expect(result.score).toBeLessThan(JUNK_PENALTY_THRESHOLD);
    expect(result.signals).toHaveLength(0);
  });

  it('detects promotional URL patterns', () => {
    const result = computeJunkScore({
      ...normalArticle,
      url: 'https://example.com/patrocinado/producto-increible',
    });
    expect(result.score).toBeGreaterThanOrEqual(0.3);
    expect(result.signals).toContain('url_pattern(1)');
  });

  it('detects UTM source in URL', () => {
    const result = computeJunkScore({
      ...normalArticle,
      url: 'https://example.com/articulo?utm_source=newsletter&utm_medium=email',
    });
    expect(result.signals.some((s) => s.startsWith('url_pattern'))).toBe(true);
  });

  it('detects junk author/section', () => {
    const result = computeJunkScore({
      ...normalArticle,
      authorOrSection: 'Contenido patrocinado',
    });
    expect(result.score).toBeGreaterThanOrEqual(JUNK_PENALTY_THRESHOLD);
    expect(result.signals.some((s) => s.startsWith('author_section'))).toBe(true);
  });

  it('detects promotional title keywords', () => {
    const result = computeJunkScore({
      ...normalArticle,
      title: '¡Oferta imperdible! Descuento en suscripciones',
    });
    expect(result.signals.some((s) => s.startsWith('title_keywords'))).toBe(true);
  });

  it('assigns half weight for single title pattern, full for two+ patterns', () => {
    const singleHit = computeJunkScore({
      ...normalArticle,
      title: 'Promoción especial de fin de año', // hits pattern 1 only
    });
    const doubleHit = computeJunkScore({
      ...normalArticle,
      title: 'Oferta exclusiva: ¡no te pierdas esta oportunidad!', // hits pattern 1 (oferta) + pattern 4 (no te pierdas + exclusiv)
    });
    expect(doubleHit.score).toBeGreaterThan(singleHit.score);
  });

  it('detects SEO spam patterns', () => {
    const result = computeJunkScore({
      ...normalArticle,
      title: 'Haz clic aquí para leer más',
      snippet: 'Haz clic aquí para ver más contenido exclusivo.',
    });
    expect(result.signals.some((s) => s.startsWith('seo_spam'))).toBe(true);
  });

  it('penalizes very short snippets', () => {
    const result = computeJunkScore({
      ...normalArticle,
      snippet: 'Corto.',
    });
    expect(result.signals).toContain('short_snippet');
  });

  it('combines multiple signals to exceed exclude threshold', () => {
    const result = computeJunkScore({
      url: 'https://example.com/patrocinado/oferta',
      title: 'Oferta gratis exclusiva compra descuento',
      snippet: 'Compra ahora',
      authorOrSection: 'Contenido patrocinado',
    });
    expect(result.score).toBeGreaterThanOrEqual(JUNK_EXCLUDE_THRESHOLD);
    expect(result.signals.length).toBeGreaterThanOrEqual(3);
  });

  it('clamps score to maximum of 1.0', () => {
    const result = computeJunkScore({
      url: 'https://example.com/patrocinado/tienda/landing/oferta',
      title: 'Oferta gratis exclusiva compra descuento',
      snippet: 'Haz clic aquí haz clic aquí https://a.com https://b.com https://c.com',
      authorOrSection: 'Contenido patrocinado',
    });
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('returns 0 score for null author', () => {
    const result = computeJunkScore({
      ...normalArticle,
      authorOrSection: null,
    });
    expect(result.score).toBeLessThan(JUNK_PENALTY_THRESHOLD);
  });
});
