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
});
