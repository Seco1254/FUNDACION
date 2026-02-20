import { describe, it, expect } from 'vitest';
import { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview, evaluatePublishGate } from './gates.js';

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

  describe('evaluatePublishGate', () => {
    it('passes multi-source gate with sufficient evidence', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 3,
        total_usable_text_len: 2000,
        key_facts_count: 8,
        overview_status: 'ready',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('multi');
      expect(result.reasons).toHaveLength(0);
    });

    it('passes single-source gate with sufficient text', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 7,
        overview_status: 'ready',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
      expect(result.reasons).toHaveLength(0);
    });

    it('passes multi-source with pending overview (evidence-based gate)', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 2,
        total_usable_text_len: 1500,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('multi');
    });

    it('passes single-source with pending overview when text is sufficient', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('fails when overview explicitly failed and text is too short', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 2,
        total_usable_text_len: 0,
        key_facts_count: 0,
        overview_status: 'failed',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('OVERVIEW_FAILED');
      expect(result.reasons).toContain('TEXT_TOO_SHORT');
    });

    it('fails when text is too short for multi-source', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 2,
        total_usable_text_len: 500,
        key_facts_count: 0,
        overview_status: 'ready',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('TEXT_TOO_SHORT');
    });

    it('fails with no sources', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 0,
        total_usable_text_len: 0,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('NO_SOURCES');
      expect(result.reasons).toContain('TEXT_TOO_SHORT');
    });
  });
});
