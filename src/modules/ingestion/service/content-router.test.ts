import { describe, it, expect } from 'vitest';
import { evaluateRoutingDecision, RoutingInput } from './content-router.js';

function makeInput(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    contentType: 'news',
    textContentLen: 1200,
    title: 'Gobierno anuncia nueva reforma tributaria',
    usableForOverview: true,
    ...overrides,
  };
}

describe('evaluateRoutingDecision', () => {
  // ── HARD NON_NEWS ────────────────────────────────────────────────

  it('institutional_static → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ contentType: 'institutional_static' }));
    expect(result).toBe('NON_NEWS');
  });

  it('short article (< 300 chars) → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ textContentLen: 200 }));
    expect(result).toBe('NON_NEWS');
  });

  it('null textContentLen → NON_NEWS (defaults to 0)', () => {
    const result = evaluateRoutingDecision(makeInput({ textContentLen: null }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Quiénes somos" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Quiénes somos - Fundación X' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Quién somos" (singular) → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Quién somos' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Política de privacidad" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Política de privacidad' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Inscripciones abiertas" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Inscripciones para curso 2026' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Edición del boletín" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Edición del boletín semanal' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Descargue el informe" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Descargue el informe anual 2025' }));
    expect(result).toBe('NON_NEWS');
  });

  it('title "Encuentro regional" → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ title: 'Encuentro de líderes sociales' }));
    expect(result).toBe('NON_NEWS');
  });

  it('usableForOverview === false → NON_NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ usableForOverview: false }));
    expect(result).toBe('NON_NEWS');
  });

  // ── SOFT LOW_CONFIDENCE ──────────────────────────────────────────

  it('institutional content type → LOW_CONFIDENCE', () => {
    const result = evaluateRoutingDecision(makeInput({ contentType: 'institutional' }));
    expect(result).toBe('LOW_CONFIDENCE');
  });

  it('opinion long article → LOW_CONFIDENCE', () => {
    const result = evaluateRoutingDecision(makeInput({
      contentType: 'opinion',
      textContentLen: 1500,
    }));
    expect(result).toBe('LOW_CONFIDENCE');
  });

  it('short text (300-599 chars) → LOW_CONFIDENCE', () => {
    const result = evaluateRoutingDecision(makeInput({ textContentLen: 450 }));
    expect(result).toBe('LOW_CONFIDENCE');
  });

  it('text exactly 599 → LOW_CONFIDENCE', () => {
    const result = evaluateRoutingDecision(makeInput({ textContentLen: 599 }));
    expect(result).toBe('LOW_CONFIDENCE');
  });

  // ── NEWS ─────────────────────────────────────────────────────────

  it('news long article → NEWS', () => {
    const result = evaluateRoutingDecision(makeInput());
    expect(result).toBe('NEWS');
  });

  it('text exactly 600 + news content_type → NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ textContentLen: 600 }));
    expect(result).toBe('NEWS');
  });

  it('unknown content_type with sufficient length → NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ contentType: 'unknown' }));
    expect(result).toBe('NEWS');
  });

  it('null content_type with sufficient length → NEWS', () => {
    const result = evaluateRoutingDecision(makeInput({ contentType: null }));
    expect(result).toBe('NEWS');
  });

  // ── Priority: hard rules beat soft rules ─────────────────────────

  it('institutional_static beats long text', () => {
    const result = evaluateRoutingDecision(makeInput({
      contentType: 'institutional_static',
      textContentLen: 5000,
    }));
    expect(result).toBe('NON_NEWS');
  });

  it('usableForOverview=false beats institutional content_type', () => {
    const result = evaluateRoutingDecision(makeInput({
      contentType: 'institutional',
      usableForOverview: false,
    }));
    expect(result).toBe('NON_NEWS');
  });
});
