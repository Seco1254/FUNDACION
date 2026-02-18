import { describe, it, expect } from 'vitest';
import { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview } from './gates.js';

describe('gates', () => {
  describe('validateOverviewEvidence', () => {
    it('passes with >= 2 sources and >= 2 quotes', () => {
      const result = validateOverviewEvidence(2, 3);
      expect(result.valid).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it('blocks when single source', () => {
      const result = validateOverviewEvidence(1, 5);
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE');
    });

    it('blocks when no quotes', () => {
      const result = validateOverviewEvidence(3, 0);
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('MISSING_QUOTES');
    });

    it('blocks with multiple reasons when both conditions fail', () => {
      const result = validateOverviewEvidence(0, 0);
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).toContain('MISSING_QUOTES');
    });

    it('blocks when exactly 1 quote', () => {
      const result = validateOverviewEvidence(2, 1);
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('MISSING_QUOTES');
    });
  });

  describe('validateOverviewContent', () => {
    it('passes with non-empty arrays', () => {
      const result = validateOverviewContent({
        what_happened: ['fact 1'],
        context: ['ctx 1'],
        in_dispute: ['disp 1'],
      });
      expect(result.valid).toBe(true);
    });

    it('blocks when what_happened is empty', () => {
      const result = validateOverviewContent({
        what_happened: [],
        context: ['ctx'],
        in_dispute: ['disp'],
      });
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('EMPTY_WHAT_HAPPENED');
    });

    it('blocks when what_happened has only empty strings', () => {
      const result = validateOverviewContent({
        what_happened: ['', '  '],
        context: ['ctx'],
        in_dispute: ['disp'],
      });
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('EMPTY_WHAT_HAPPENED');
    });

    it('blocks when context is missing', () => {
      const result = validateOverviewContent({
        what_happened: ['fact'],
        context: [],
        in_dispute: ['disp'],
      });
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('EMPTY_CONTEXT');
    });
  });

  describe('buildInsufficientOverview', () => {
    it('returns INSUFFICIENT_EVIDENCE with reasons', () => {
      const result = buildInsufficientOverview(['SINGLE_SOURCE', 'MISSING_QUOTES']);
      expect(result.status).toBe('INSUFFICIENT_EVIDENCE');
      expect(result.what_happened).toEqual(['Evidencia insuficiente para un resumen confiable.']);
      expect(result.context).toEqual([]);
      expect(result.in_dispute).toEqual([]);
      expect(result.confidence_label).toBe('No concluyente');
      expect(result.why).toContain('SINGLE_SOURCE');
      expect(result.why).toContain('MISSING_QUOTES');
    });
  });
});
