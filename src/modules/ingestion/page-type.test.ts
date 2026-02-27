import { describe, it, expect } from 'vitest';
import { classifyPageType, shouldBlockPageType, type PageType } from './page-type.js';

// ── Helper ─────────────────────────────────────────────────────

function classify(url: string, title?: string | null) {
  return classifyPageType({ url, title });
}

// ── AUTHOR_PAGE ────────────────────────────────────────────────

describe('classifyPageType — AUTHOR_PAGE', () => {
  it('blocks /autor/ URL pattern', () => {
    const r = classify('https://www.eltiempo.com/autor/juan-perez');
    expect(r.pageType).toBe('AUTHOR_PAGE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.flags.is_author).toBe(true);
  });

  it('blocks /autores/ URL pattern', () => {
    const r = classify('https://www.eltiempo.com/autores/maria-garcia');
    expect(r.pageType).toBe('AUTHOR_PAGE');
  });

  it('blocks /columnista/ URL pattern', () => {
    const r = classify('https://www.semana.com/columnista/salud-hernandez');
    expect(r.pageType).toBe('AUTHOR_PAGE');
  });

  it('blocks title containing "Noticias, Fotos y Videos de"', () => {
    const r = classify(
      'https://www.eltiempo.com/noticias/gustavo-petro',
      'Noticias, Fotos y Videos de Gustavo Petro - El Tiempo',
    );
    expect(r.pageType).toBe('AUTHOR_PAGE');
    expect(r.reasons.some((s) => s.startsWith('TITLE_MATCH'))).toBe(true);
  });

  it('higher confidence when both URL and title match', () => {
    const r = classify(
      'https://www.eltiempo.com/autor/gustavo-petro',
      'Noticias, Fotos y Videos de Gustavo Petro',
    );
    expect(r.pageType).toBe('AUTHOR_PAGE');
    expect(r.confidence).toBeGreaterThanOrEqual(0.95);
  });
});

// ── COMMERCIAL_CONTENT ─────────────────────────────────────────

describe('classifyPageType — COMMERCIAL_CONTENT', () => {
  it('blocks /contenido-comercial/ URL', () => {
    const r = classify('https://www.eltiempo.com/contenido-comercial/oferta-bancaria');
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
    expect(r.flags.is_commercial).toBe(true);
  });

  it('blocks /contenido-patrocinado/ URL', () => {
    const r = classify('https://www.semana.com/contenido-patrocinado/campana-xyz');
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
  });

  it('blocks /publireportaje/ URL', () => {
    const r = classify('https://www.eltiempo.com/publireportaje/banco-abc');
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
  });

  it('blocks /branded-content/ URL', () => {
    const r = classify('https://www.eltiempo.com/branded-content/tech-summit');
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
  });

  it('blocks title "contenido comercial"', () => {
    const r = classify(
      'https://www.eltiempo.com/economia/algo',
      'Contenido comercial: Las mejores ofertas del mes',
    );
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
  });
});

// ── LISTING_INDEX ──────────────────────────────────────────────

describe('classifyPageType — LISTING_INDEX', () => {
  it('blocks /tag/ URL', () => {
    const r = classify('https://www.eltiempo.com/tag/economia');
    expect(r.pageType).toBe('LISTING_INDEX');
    expect(r.flags.is_listing).toBe(true);
  });

  it('blocks /categoria/ URL', () => {
    const r = classify('https://www.semana.com/categoria/politica');
    expect(r.pageType).toBe('LISTING_INDEX');
  });

  it('blocks /temas/ URL', () => {
    const r = classify('https://www.eltiempo.com/temas/transmilenio');
    expect(r.pageType).toBe('LISTING_INDEX');
  });

  it('blocks /buscador URL', () => {
    const r = classify('https://www.eltiempo.com/buscador?q=reforma');
    expect(r.pageType).toBe('LISTING_INDEX');
  });

  it('blocks /archivo/ URL', () => {
    const r = classify('https://www.eltiempo.com/archivo/documento/MAM-123');
    expect(r.pageType).toBe('LISTING_INDEX');
  });

  it('blocks /seccion/ URL', () => {
    const r = classify('https://www.eltiempo.com/seccion/deportes');
    expect(r.pageType).toBe('LISTING_INDEX');
  });

  it('blocks title "Últimas noticias de..."', () => {
    const r = classify(
      'https://www.eltiempo.com/noticias/bogota',
      'Noticias sobre Bogotá - El Tiempo',
    );
    expect(r.pageType).toBe('LISTING_INDEX');
  });
});

// ── ARTICLE (allowed) ──────────────────────────────────────────

describe('classifyPageType — ARTICLE (default)', () => {
  it('allows normal article URL (e.g. /bogota/...)', () => {
    const r = classify(
      'https://www.eltiempo.com/bogota/protestas-en-bogota-por-transmilenio-123456',
      'Protestas en Bogotá por crisis de TransMilenio',
    );
    expect(r.pageType).toBe('ARTICLE');
    expect(r.confidence).toBe(1.0);
    expect(r.flags.is_author).toBe(false);
    expect(r.flags.is_commercial).toBe(false);
    expect(r.flags.is_listing).toBe(false);
  });

  it('allows /politica/ article URL', () => {
    const r = classify(
      'https://www.eltiempo.com/politica/gobierno/reforma-tributaria-2026-123456',
      'Gobierno anuncia nueva reforma tributaria',
    );
    expect(r.pageType).toBe('ARTICLE');
  });

  it('allows semana.com article URL', () => {
    const r = classify(
      'https://www.semana.com/economia/articulo/inflacion-enero-2026/123456',
      'Inflación de enero 2026',
    );
    expect(r.pageType).toBe('ARTICLE');
  });

  it('allows /deportes/ article URL', () => {
    const r = classify(
      'https://www.eltiempo.com/deportes/futbol/seleccion-colombia-mundial-123456',
      'Colombia clasifica al Mundial',
    );
    expect(r.pageType).toBe('ARTICLE');
  });
});

// ── shouldBlockPageType ────────────────────────────────────────

describe('shouldBlockPageType', () => {
  const cases: Array<[PageType, boolean]> = [
    ['ARTICLE', false],
    ['AUTHOR_PAGE', true],
    ['COMMERCIAL_CONTENT', true],
    ['LISTING_INDEX', true],
    ['OTHER', true],
  ];

  it.each(cases)('shouldBlockPageType(%s) → %s', (type, expected) => {
    expect(shouldBlockPageType(type)).toBe(expected);
  });
});

// ── Edge cases ─────────────────────────────────────────────────

describe('classifyPageType — edge cases', () => {
  it('handles URL with no pathname gracefully', () => {
    const r = classify('https://www.eltiempo.com');
    expect(r.pageType).toBe('ARTICLE');
  });

  it('handles malformed URL gracefully', () => {
    const r = classify('not-a-valid-url');
    expect(r.pageType).toBe('ARTICLE'); // fallback: default
  });

  it('handles null title', () => {
    const r = classify('https://www.eltiempo.com/bogota/test-123', null);
    expect(r.pageType).toBe('ARTICLE');
  });

  it('handles empty title', () => {
    const r = classify('https://www.eltiempo.com/bogota/test-123', '');
    expect(r.pageType).toBe('ARTICLE');
  });

  it('AUTHOR_PAGE takes priority over LISTING if URL has both patterns', () => {
    const r = classify('https://www.eltiempo.com/autor/tag/juan-perez');
    // /autor/ matched first → AUTHOR_PAGE
    expect(r.pageType).toBe('AUTHOR_PAGE');
  });

  it('COMMERCIAL_CONTENT takes priority over LISTING', () => {
    const r = classify('https://www.eltiempo.com/contenido-comercial/tag/promo');
    // /contenido-comercial/ matched before /tag/
    expect(r.pageType).toBe('COMMERCIAL_CONTENT');
  });
});
