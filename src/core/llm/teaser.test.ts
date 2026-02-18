import { describe, it, expect } from 'vitest';
import { deriveTeaser } from './teaser.js';

describe('deriveTeaser', () => {
  it('joins bullets and truncates to 140 chars', () => {
    const bullets = [
      'El gobierno presentó la reforma tributaria.',
      'Los impuestos aumentarán un 15% para grandes empresas.',
      'La oposición rechazó la medida y convocó protestas masivas en las principales ciudades del país durante la semana.',
    ];
    const teaser = deriveTeaser(bullets);
    expect(teaser.length).toBeLessThanOrEqual(140);
    expect(teaser.length).toBeGreaterThan(0);
  });

  it('returns full text if under 140 chars', () => {
    const bullets = ['Hecho simple.'];
    const teaser = deriveTeaser(bullets);
    expect(teaser).toBe('Hecho simple.');
  });

  it('returns empty string for null/undefined/empty input', () => {
    expect(deriveTeaser(null)).toBe('');
    expect(deriveTeaser(undefined)).toBe('');
    expect(deriveTeaser([])).toBe('');
  });

  it('filters out empty strings', () => {
    const teaser = deriveTeaser(['', '  ', 'Real content']);
    expect(teaser).toBe('Real content');
  });

  it('ends with ellipsis when truncated', () => {
    const long = ['A'.repeat(200)];
    const teaser = deriveTeaser(long);
    expect(teaser.length).toBeLessThanOrEqual(140);
    expect(teaser.endsWith('\u2026')).toBe(true);
  });

  it('respects custom maxLen', () => {
    const teaser = deriveTeaser(['Hello world this is a test'], 10);
    expect(teaser.length).toBeLessThanOrEqual(10);
  });
});
