import { describe, it, expect } from 'vitest';
import { isSpanish } from './language-detector.js';

describe('isSpanish', () => {
  it('detects Spanish text', () => {
    const text =
      'El presidente de Colombia anunció una nueva reforma tributaria que busca aumentar los ingresos del Estado en un 15 por ciento para financiar programas sociales.';
    expect(isSpanish(text)).toBe(true);
  });

  it('detects English text as not Spanish', () => {
    const text =
      'The president of the United States announced a new tax reform that would increase government revenue by 15 percent to fund social programs.';
    expect(isSpanish(text)).toBe(false);
  });

  it('returns false for empty text', () => {
    expect(isSpanish('')).toBe(false);
  });

  it('returns true for text with no recognized stopwords (benefit of doubt)', () => {
    expect(isSpanish('Bogotá Medellín Cali Cartagena')).toBe(true);
  });

  it('detects mixed text with majority Spanish', () => {
    const text =
      'La economía de Colombia ha crecido en los últimos años según el Banco de la República y sus proyecciones para el futuro son positivas.';
    expect(isSpanish(text)).toBe(true);
  });

  it('rejects text with majority English stopwords', () => {
    const text =
      'This is a report about the economic situation in the country and what should be done to improve it for the citizens.';
    expect(isSpanish(text)).toBe(false);
  });

  describe('short-text guard (< 40 tokens)', () => {
    it('blocks short English text with EN stopwords', () => {
      const text = 'The new reform would change the tax system for the country';
      expect(isSpanish(text)).toBe(false);
    });

    it('passes short Spanish text with only ES stopwords', () => {
      const text = 'La nueva reforma del sistema tributario para el país';
      expect(isSpanish(text)).toBe(true);
    });

    it('passes short Spanish text without any stopwords', () => {
      const text = 'Bogotá Medellín Cali';
      expect(isSpanish(text)).toBe(true);
    });

    it('long mixed text still uses ratio (existing behavior)', () => {
      // > 40 tokens, mostly Spanish, some EN words
      const text =
        'El presidente de Colombia anunció que la reforma tributaria del gobierno busca aumentar ' +
        'los ingresos del Estado para financiar programas sociales en el país durante los próximos ' +
        'años según las proyecciones del Banco de la República que indican crecimiento sostenido ' +
        'a report by the World Bank suggests';
      expect(isSpanish(text)).toBe(true);
    });
  });
});
