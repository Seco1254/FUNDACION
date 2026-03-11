import { describe, it, expect } from 'vitest';
import { detectBoilerplate } from './boilerplate.js';

describe('detectBoilerplate', () => {
  it('returns rate 0 for empty array', () => {
    const result = detectBoilerplate([]);
    expect(result.rate).toBe(0);
    expect(result.total).toBe(0);
    expect(result.matched).toBe(0);
  });

  it('detects Spanish boilerplate patterns', () => {
    const bullets = [
      'Suscríbete a nuestro newsletter para más información.',
      'El presidente anunció nuevas medidas económicas.',
      'Inicia sesión para leer el artículo completo.',
      'Descarga la app desde Google Play.',
    ];
    const result = detectBoilerplate(bullets);
    expect(result.matched).toBe(3);
    expect(result.total).toBe(4);
    expect(result.rate).toBeCloseTo(0.75, 2);
    expect(result.matched_samples).toHaveLength(3);
  });

  it('returns rate 0 for clean bullets', () => {
    const bullets = [
      'El gobierno colombiano aprobó una reforma tributaria.',
      'La inflación bajó al 5.2% interanual.',
      'Tres departamentos reportaron inundaciones graves.',
    ];
    const result = detectBoilerplate(bullets);
    expect(result.matched).toBe(0);
    expect(result.rate).toBe(0);
  });

  it('supports extra custom patterns', () => {
    const bullets = ['BREAKING NEWS: algo pasó.'];
    const result = detectBoilerplate(bullets, [/\bBREAKING NEWS\b/i]);
    expect(result.matched).toBe(1);
    expect(result.rate).toBe(1);
  });

  it('counts each bullet at most once even if it matches multiple patterns', () => {
    const bullets = [
      'Suscríbete a nuestro newsletter y acepta cookies.',
    ];
    const result = detectBoilerplate(bullets);
    expect(result.matched).toBe(1);
    expect(result.total).toBe(1);
  });

  it('truncates long samples to 120 chars', () => {
    const long = 'Suscríbete ' + 'a'.repeat(200);
    const result = detectBoilerplate([long]);
    expect(result.matched_samples[0].length).toBeLessThanOrEqual(120);
  });

  it('keeps at most 3 samples', () => {
    const bullets = [
      'Suscríbete uno',
      'Newsletter dos',
      'Cookies tres',
      'Inicia sesión cuatro',
    ];
    const result = detectBoilerplate(bullets);
    expect(result.matched).toBe(4);
    expect(result.matched_samples).toHaveLength(3);
  });
});
