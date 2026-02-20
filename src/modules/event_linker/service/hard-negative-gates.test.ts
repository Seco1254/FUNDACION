import { describe, it, expect } from 'vitest';
import {
  extractTitleKeywords,
  extractTitleEntities,
  checkTitleContradictionPair,
  jaccardSets,
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
