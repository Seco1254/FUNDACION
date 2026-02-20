import { describe, it, expect } from 'vitest';
import { extractFacts } from './facts-extractor.js';

function makeClaim(overrides: Record<string, any> = {}) {
  return {
    id: 'c1',
    claimText: 'El gobierno aprobó la reforma tributaria',
    claimType: 'FACT',
    status: 'SUPPORTED',
    quotes: [{
      quoteText: 'El gobierno aprobó la reforma tributaria en primer debate.',
      article: {
        url: 'https://eltiempo.com/1',
        media: { mediaKey: 'eltiempo', name: 'El Tiempo' },
      },
    }],
    ...overrides,
  };
}

function makeArticle(overrides: Record<string, any> = {}) {
  return {
    title: 'Reforma tributaria aprobada',
    textNorm: 'El gobierno colombiano aprobó la reforma tributaria...',
    url: 'https://eltiempo.com/1',
    mediaKey: 'eltiempo',
    mediaName: 'El Tiempo',
    textContentLen: 1500,
    ...overrides,
  };
}

describe('extractFacts', () => {
  it('extracts key_facts from SUPPORTED claims with quotes', () => {
    const claims = [
      makeClaim(),
      makeClaim({
        id: 'c2',
        claimText: 'La reforma incluye nuevos impuestos',
        quotes: [{
          quoteText: 'Nuevos impuestos fueron incluidos en el proyecto.',
          article: {
            url: 'https://elespectador.com/1',
            media: { mediaKey: 'elespectador', name: 'El Espectador' },
          },
        }],
      }),
    ];
    const articles = [
      makeArticle(),
      makeArticle({ url: 'https://elespectador.com/1', mediaKey: 'elespectador', mediaName: 'El Espectador', textContentLen: 1200 }),
    ];

    const result = extractFacts(claims, articles, 'Reforma tributaria');

    expect(result.canonical_title).toBe('Reforma tributaria');
    expect(result.key_facts).toHaveLength(2);
    expect(result.key_facts[0].text).toBe('El gobierno aprobó la reforma tributaria');
    expect(result.key_facts[0].source_id).toBe('eltiempo');
    expect(result.key_facts[1].source_id).toBe('elespectador');
    expect(result.coverage_summary.sources_count).toBe(2);
    expect(result.coverage_summary.source_names).toContain('El Tiempo');
    expect(result.coverage_summary.source_names).toContain('El Espectador');
    expect(result.coverage_summary.articles_used).toBe(2);
    expect(result.coverage_summary.total_text_len).toBe(2700);
  });

  it('puts INSUFFICIENT claims in uncertainties', () => {
    const claims = [
      makeClaim({ id: 'c1', status: 'INSUFFICIENT', claimText: 'No se confirma el monto exacto' }),
    ];
    const articles = [makeArticle()];

    const result = extractFacts(claims, articles, null);

    expect(result.uncertainties).toContain('No se confirma el monto exacto');
    expect(result.key_facts).toHaveLength(0);
  });

  it('puts DISPUTED claims in conflicts with media names', () => {
    const claims = [
      makeClaim({
        id: 'c1',
        status: 'DISPUTED',
        claimText: 'El monto de la reforma es de 25 billones',
        quotes: [
          { quoteText: 'quote 1', article: { url: 'u1', media: { mediaKey: 'eltiempo', name: 'El Tiempo' } } },
          { quoteText: 'quote 2', article: { url: 'u2', media: { mediaKey: 'elespectador', name: 'El Espectador' } } },
        ],
      }),
    ];
    const articles = [makeArticle()];

    const result = extractFacts(claims, articles, null);

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toContain('El monto de la reforma');
    expect(result.conflicts[0]).toContain('El Tiempo');
    expect(result.conflicts[0]).toContain('El Espectador');
    // DISPUTED claims also appear in key_facts
    expect(result.key_facts).toHaveLength(1);
  });

  it('returns valid empty structure when no claims', () => {
    const result = extractFacts([], [makeArticle()], 'Test headline');

    expect(result.canonical_title).toBe('Test headline');
    expect(result.key_facts).toHaveLength(0);
    expect(result.uncertainties).toHaveLength(0);
    expect(result.conflicts).toHaveLength(0);
    expect(result.coverage_summary.sources_count).toBe(1);
    expect(result.coverage_summary.articles_used).toBe(1);
  });

  it('uses first article title when headline is null', () => {
    const result = extractFacts([], [makeArticle({ title: 'Fallback title' })], null);
    expect(result.canonical_title).toBe('Fallback title');
  });

  it('extracts when from dates in claim text', () => {
    const claims = [
      makeClaim({ claimText: 'El 15 de junio de 2025 se aprobó la reforma' }),
    ];
    const result = extractFacts(claims, [makeArticle()], null);
    expect(result.when.length).toBeGreaterThan(0);
  });

  it('extracts where from Colombian cities in text', () => {
    const claims = [
      makeClaim({ claimText: 'La protesta en Bogotá dejó 5 heridos' }),
    ];
    const result = extractFacts(claims, [makeArticle()], null);
    expect(result.where).toContain('Bogotá');
  });
});
