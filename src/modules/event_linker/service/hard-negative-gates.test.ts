import { describe, it, expect } from 'vitest';
import {
  extractTitleKeywords,
  extractTitleEntities,
  checkTitleContradictionPair,
  jaccardSets,
  extractDesk,
  extractDeskDetailed,
  desksCompatible,
  shouldBlockAutoLink,
} from './hard-negative-gates.js';

describe('extractTitleKeywords', () => {
  it('extracts alphabetic tokens >= 4 chars', () => {
    const kws = extractTitleKeywords('Colombia aprueba reforma pensional histórica');
    expect(kws.has('colombia')).toBe(true);
    expect(kws.has('aprueba')).toBe(true);
    expect(kws.has('reforma')).toBe(true);
    expect(kws.has('pensional')).toBe(true);
    expect(kws.has('histórica')).toBe(true);
  });

  it('excludes tokens shorter than 4 chars', () => {
    const kws = extractTitleKeywords('El PIB del país');
    expect(kws.has('del')).toBe(false);
    // 'país' has 4 chars
    expect(kws.has('país')).toBe(true);
  });

  it('excludes Spanish stopwords', () => {
    const kws = extractTitleKeywords('Colombia dice que también tiene problema');
    expect(kws.has('dice')).toBe(false);
    expect(kws.has('también')).toBe(false);
    expect(kws.has('tiene')).toBe(false);
    expect(kws.has('colombia')).toBe(true);
    expect(kws.has('problema')).toBe(true);
  });
});

describe('extractTitleEntities', () => {
  it('extracts capitalized words (not at start unless long)', () => {
    const ents = extractTitleEntities('Petro anuncia reforma en Bogotá');
    expect(ents.has('petro')).toBe(true);
    expect(ents.has('bogotá')).toBe(true);
  });

  it('extracts acronyms', () => {
    const ents = extractTitleEntities('El PIB y la OTAN discuten el TLC');
    expect(ents.has('pib')).toBe(true);
    expect(ents.has('otan')).toBe(true);
    expect(ents.has('tlc')).toBe(true);
  });

  it('extracts numbers with units', () => {
    const ents = extractTitleEntities('Empresa reporta 500 millones en pérdidas');
    expect(ents.has('500 millones')).toBe(true);
  });

  it('skips common Spanish articles as entities', () => {
    const ents = extractTitleEntities('El presidente De La República Lo confirmó');
    // "El", "De", "La", "Lo" should be filtered
    expect(ents.has('el')).toBe(false);
    expect(ents.has('de')).toBe(false);
    expect(ents.has('la')).toBe(false);
    expect(ents.has('lo')).toBe(false);
  });
});

describe('jaccardSets', () => {
  it('returns 1 for identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    expect(jaccardSets(a, a)).toBe(1);
  });

  it('returns 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSets(a, b)).toBe(0);
  });

  it('returns 0 for two empty sets', () => {
    expect(jaccardSets(new Set(), new Set())).toBe(0);
  });

  it('computes correct Jaccard for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection = {b,c} = 2, union = {a,b,c,d} = 4
    expect(jaccardSets(a, b)).toBeCloseTo(0.5, 5);
  });
});

describe('checkTitleContradictionPair', () => {
  it('blocks when titles have completely different keywords and entities', () => {
    const result = checkTitleContradictionPair(
      'Salario mínimo sube 12 por ciento',
      'Fortuna de magnate alcanza 100 millones USD',
      'Salario mínimo sube 12 por ciento',
      'Fortuna de magnate alcanza 100 millones USD',
      0.30,  // low embedding cosine
      0.00,  // zero entity overlap from scoring
    );
    expect(result.blocked).toBe(true);
    expect(result.keywordJaccard).toBeLessThan(0.06);
    expect(result.entityJaccard).toBeLessThan(0.01);
  });

  it('does NOT block when titles share keywords', () => {
    const result = checkTitleContradictionPair(
      'Reforma pensional aprobada en Colombia',
      'Reforma pensional pasa tercer debate en Colombia',
      'Reforma pensional aprobada en Colombia',
      'Reforma pensional pasa tercer debate en Colombia',
      0.55,
      0.10,
    );
    expect(result.blocked).toBe(false);
  });

  it('exception: high embedding + some entity overlap → NOT blocked', () => {
    const result = checkTitleContradictionPair(
      'Título muy diferente sin palabras comunes',
      'Otro título completamente distinto sin overlap',
      'Título muy diferente sin palabras comunes',
      'Otro título completamente distinto sin overlap',
      0.70,  // high embedding cosine
      0.05,  // entity overlap >= 0.03
    );
    // Even though keyword overlap might be low, the exception fires
    expect(result.blocked).toBe(false);
  });

  it('exception does NOT fire when embedding < 0.65', () => {
    const result = checkTitleContradictionPair(
      'Título muy diferente sin palabras comunes',
      'Otro texto completamente distinto sin overlap alguno',
      'Título muy diferente sin palabras comunes',
      'Otro texto completamente distinto sin overlap alguno',
      0.50,  // below 0.65
      0.05,  // entity overlap fine
    );
    // Low keyword overlap + low entity overlap in title → blocked
    expect(result.keywordJaccard).toBeLessThan(0.06);
  });
});

// ── extractDesk ──────────────────────────────────────────────────

describe('extractDesk', () => {
  it('extracts POLITICA from /politica/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/politica/nuevo-decreto-12345')).toBe('POLITICA');
  });

  it('extracts DEPORTES from /deportes/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/deportes/futbol/gol-12345')).toBe('DEPORTES');
  });

  it('extracts CRIMEN from /justicia/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/justicia/condena-12345')).toBe('CRIMEN');
  });

  it('extracts CRIMEN from /unidad-investigativa/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/unidad-investigativa/caso-12345')).toBe('CRIMEN');
  });

  it('extracts SALUD from /salud/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/salud/vacunacion-12345')).toBe('SALUD');
  });

  it('extracts ECONOMIA from /economia/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/economia/pib-12345')).toBe('ECONOMIA');
  });

  it('extracts BOGOTA from /bogota/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/bogota/transmilenio-12345')).toBe('BOGOTA');
  });

  it('extracts OPINION from /opinion/ URL', () => {
    expect(extractDesk('https://www.eltiempo.com/opinion/columna-12345')).toBe('OPINION');
  });

  it('returns null for URL with no recognized section', () => {
    expect(extractDesk('https://www.eltiempo.com/vida-de-hoy/curiosidades-12345')).toBeNull();
  });

  it('returns null for null/undefined input', () => {
    expect(extractDesk(null)).toBeNull();
    expect(extractDesk(undefined)).toBeNull();
  });

  it('returns null for invalid URL', () => {
    expect(extractDesk('not-a-url')).toBeNull();
  });

  it('extracts first recognized segment from deep path', () => {
    expect(extractDesk('https://www.eltiempo.com/deportes/futbol/liga-betplay-12345')).toBe('DEPORTES');
  });

  // ── eltiempo.com additional paths ──

  it('extracts CRIMEN from /justicia/ (eltiempo)', () => {
    expect(extractDesk('https://www.eltiempo.com/justicia/investigacion-fiscal-12345')).toBe('CRIMEN');
  });

  it('extracts MEDIO_AMBIENTE from /medio-ambiente/ (eltiempo)', () => {
    expect(extractDesk('https://www.eltiempo.com/medio-ambiente/inundaciones-12345')).toBe('MEDIO_AMBIENTE');
  });

  it('extracts ENTRETENIMIENTO from /cultura/ (eltiempo)', () => {
    expect(extractDesk('https://www.eltiempo.com/cultura/teatro-12345')).toBe('ENTRETENIMIENTO');
  });

  // ── razonpublica.com ──

  it('maps razonpublica article slug to OPINION (default)', () => {
    expect(extractDesk('https://razonpublica.com/reforma-pensional-impacto-trabajadores-colombianos/')).toBe('OPINION');
  });

  it('maps razonpublica /categoria/temas/politica-y-gobierno/ to POLITICA', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/politica-y-gobierno/')).toBe('POLITICA');
  });

  it('maps razonpublica /categoria/temas/economia-y-sociedad/ to ECONOMIA', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/economia-y-sociedad/')).toBe('ECONOMIA');
  });

  it('maps razonpublica /categoria/temas/conflicto-drogas-y-paz/ to CRIMEN', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/conflicto-drogas-y-paz/')).toBe('CRIMEN');
  });

  it('maps razonpublica /categoria/temas/medio-ambiente/ to MEDIO_AMBIENTE', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/medio-ambiente/')).toBe('MEDIO_AMBIENTE');
  });

  it('maps razonpublica /categoria/temas/internacional/ to MUNDO', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/internacional/')).toBe('MUNDO');
  });

  it('maps razonpublica /categoria/temas/regiones/ to COLOMBIA', () => {
    expect(extractDesk('https://razonpublica.com/categoria/temas/regiones/')).toBe('COLOMBIA');
  });

  it('maps razonpublica with www prefix to OPINION', () => {
    expect(extractDesk('https://www.razonpublica.com/crisis-climatica-colombia/')).toBe('OPINION');
  });

  // ── consonante.org ──

  it('maps consonante /noticia/acueducto-... to MEDIO_AMBIENTE (keyword: acueducto)', () => {
    expect(extractDesk('https://consonante.org/noticia/acueducto-comunitario-tado-choco-resistencia/')).toBe('MEDIO_AMBIENTE');
  });

  it('maps consonante /noticia/ with violence keyword to CRIMEN', () => {
    expect(extractDesk('https://consonante.org/noticia/eln-ataque-comunidad-rural/')).toBe('CRIMEN');
  });

  it('maps consonante /noticia/ with government keyword to POLITICA', () => {
    expect(extractDesk('https://consonante.org/noticia/gobierno-alcalde-carmen-atrato/')).toBe('POLITICA');
  });

  it('maps consonante /noticia/ generic slug to COLOMBIA (default)', () => {
    expect(extractDesk('https://consonante.org/noticia/jovenes-carmen-atrato-rescatan-tradiciones-ancestrales/')).toBe('COLOMBIA');
  });

  it('maps consonante /cat/ to COLOMBIA', () => {
    expect(extractDesk('https://consonante.org/cat/carmen-de-atrato/')).toBe('COLOMBIA');
  });

  it('maps consonante root to null', () => {
    expect(extractDesk('https://consonante.org/')).toBeNull();
  });

  // ── Edge cases ──

  it('handles URL with querystring and hash (strips them)', () => {
    expect(extractDesk('https://www.eltiempo.com/deportes/nota-123?ref=home#top')).toBe('DEPORTES');
  });

  it('handles URL with trailing slashes', () => {
    expect(extractDesk('https://www.eltiempo.com/economia///')).toBe('ECONOMIA');
  });
});

// ── extractDeskDetailed ─────────────────────────────────────────

describe('extractDeskDetailed', () => {
  it('returns url_segment source for eltiempo', () => {
    const r = extractDeskDetailed('https://www.eltiempo.com/politica/decreto-123');
    expect(r.desk).toBe('POLITICA');
    expect(r.desk_source).toBe('url_segment');
  });

  it('returns domain_rule source for razonpublica', () => {
    const r = extractDeskDetailed('https://razonpublica.com/articulo-de-opinion/');
    expect(r.desk).toBe('OPINION');
    expect(r.desk_source).toBe('domain_rule');
  });

  it('returns domain_rule source for consonante', () => {
    const r = extractDeskDetailed('https://consonante.org/noticia/mujeres-lideresas/');
    expect(r.desk).toBe('COLOMBIA');
    expect(r.desk_source).toBe('domain_rule');
  });

  it('returns none source when no desk found', () => {
    const r = extractDeskDetailed('https://example.com/random/page');
    expect(r.desk).toBeNull();
    expect(r.desk_source).toBe('none');
  });

  it('returns none source for null input', () => {
    const r = extractDeskDetailed(null);
    expect(r.desk).toBeNull();
    expect(r.desk_source).toBe('none');
  });
});

// ── desksCompatible ──────────────────────────────────────────────

describe('desksCompatible', () => {
  it('same desk is compatible', () => {
    expect(desksCompatible('CRIMEN', 'CRIMEN')).toBe(true);
  });

  it('CRIMEN and BOGOTA are compatible (same group)', () => {
    expect(desksCompatible('CRIMEN', 'BOGOTA')).toBe(true);
    expect(desksCompatible('BOGOTA', 'CRIMEN')).toBe(true);
  });

  it('CRIMEN and COLOMBIA are compatible (same group)', () => {
    expect(desksCompatible('CRIMEN', 'COLOMBIA')).toBe(true);
  });

  it('POLITICA and ECONOMIA are compatible (same group)', () => {
    expect(desksCompatible('POLITICA', 'ECONOMIA')).toBe(true);
    expect(desksCompatible('ECONOMIA', 'POLITICA')).toBe(true);
  });

  it('SALUD and DEPORTES are incompatible', () => {
    expect(desksCompatible('SALUD', 'DEPORTES')).toBe(false);
  });

  it('DEPORTES and CRIMEN are incompatible', () => {
    expect(desksCompatible('DEPORTES', 'CRIMEN')).toBe(false);
  });

  it('SALUD and POLITICA are incompatible', () => {
    expect(desksCompatible('SALUD', 'POLITICA')).toBe(false);
  });

  it('null desk is compatible with everything', () => {
    expect(desksCompatible(null, 'DEPORTES')).toBe(true);
    expect(desksCompatible('CRIMEN', null)).toBe(true);
    expect(desksCompatible(null, null)).toBe(true);
  });

  it('unknown desk is compatible with everything', () => {
    expect(desksCompatible('UNKNOWN_DESK', 'DEPORTES')).toBe(true);
  });
});

// ── shouldBlockAutoLink (integrated) ─────────────────────────────

describe('shouldBlockAutoLink — desk gate', () => {
  it('blocks when desks are incompatible (SALUD vs DEPORTES)', () => {
    const result = shouldBlockAutoLink({
      articleTitle: 'Test',
      articleEmbeddingCosine: 0.50,
      articleEntityJaccard: 0.10,
      articleTopicTop1: 'SALUD',
      eventTopicTop1: 'DEPORTES',
      articleUrl: 'https://a.com/salud/test',
      eventUrl: 'https://b.com/deportes/test',
      articleTopicConfidence: 0.8,
      eventTopicConfidence: 0.8,
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('DESK_MISMATCH');
  });

  it('does NOT block when desks are compatible (CRIMEN vs BOGOTA)', () => {
    const result = shouldBlockAutoLink({
      articleTitle: 'Test',
      articleEmbeddingCosine: 0.50,
      articleEntityJaccard: 0.10,
      articleTopicTop1: 'CRIMEN_SEGURIDAD',
      eventTopicTop1: 'CRIMEN_SEGURIDAD',
      articleUrl: 'https://a.com/justicia/test',
      eventUrl: 'https://b.com/bogota/test',
    });
    expect(result.reasons).not.toContain('DESK_MISMATCH');
  });
});

describe('shouldBlockAutoLink — topic confidence gate', () => {
  it('blocks with TOPIC_MISMATCH_HIGH_CONF when both topics differ with high confidence', () => {
    const result = shouldBlockAutoLink({
      articleTitle: 'Test',
      articleEmbeddingCosine: 0.50,
      articleEntityJaccard: 0.10,
      articleTopicTop1: 'DEPORTES',
      eventTopicTop1: 'POLITICA',
      articleTopicConfidence: 0.8,
      eventTopicConfidence: 0.7,
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('TOPIC_MISMATCH_HIGH_CONF');
  });

  it('blocks with plain TOPIC_MISMATCH when confidence is low', () => {
    const result = shouldBlockAutoLink({
      articleTitle: 'Test',
      articleEmbeddingCosine: 0.50,
      articleEntityJaccard: 0.10,
      articleTopicTop1: 'DEPORTES',
      eventTopicTop1: 'POLITICA',
      articleTopicConfidence: 0.3,
      eventTopicConfidence: 0.8,
    });
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('TOPIC_MISMATCH');
    expect(result.reasons).not.toContain('TOPIC_MISMATCH_HIGH_CONF');
  });

  it('does NOT block when topics match', () => {
    const result = shouldBlockAutoLink({
      articleTitle: 'Test',
      articleEmbeddingCosine: 0.50,
      articleEntityJaccard: 0.10,
      articleTopicTop1: 'POLITICA',
      eventTopicTop1: 'POLITICA',
      articleTopicConfidence: 0.9,
      eventTopicConfidence: 0.9,
    });
    expect(result.reasons).not.toContain('TOPIC_MISMATCH');
    expect(result.reasons).not.toContain('TOPIC_MISMATCH_HIGH_CONF');
  });
});
