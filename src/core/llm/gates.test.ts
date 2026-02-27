import { describe, it, expect } from 'vitest';
import { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview, evaluatePublishGate, computeImportanceScore } from './gates.js';

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
    it('passes with non-empty arrays of proper sentences', () => {
      const result = validateOverviewContent({
        what_happened: ['Según El Tiempo, el gobierno colombiano anunció nuevas medidas económicas para enfrentar la inflación en el país durante este trimestre.'],
        context: ['El contexto general indica que las medidas se adoptaron después de meses de debate entre los principales actores económicos del país.'],
        in_dispute: ['Algunos medios señalan que las cifras presentadas por el gobierno difieren de las proyecciones del Banco de la República.'],
      });
      expect(result.valid).toBe(true);
    });

    it('blocks when all what_happened bullets are telegraphic (< 15 words)', () => {
      const result = validateOverviewContent({
        what_happened: ['fact 1', 'short bullet'],
        context: ['Some context sentence with enough words to pass the basic check easily.'],
        in_dispute: ['A dispute sentence long enough to meet the requirements.'],
      });
      expect(result.valid).toBe(false);
      expect(result.reasons).toContain('TELEGRAPHIC_WHAT_HAPPENED');
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

    it('passes single-source gate with sufficient text (no disclaimer required)', () => {
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

    it('passes when overview is unavailable', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 2,
        total_usable_text_len: 1500,
        key_facts_count: 0,
        overview_status: 'unavailable',
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

    it('blocks when overview_status is failed', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 3,
        total_usable_text_len: 2000,
        key_facts_count: 8,
        overview_status: 'failed',
        has_disclaimer: false,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('OVERVIEW_FAILED');
    });

    it('blocks when overview failed and text is too short', () => {
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

    it('blocks when text is too short for multi-source', () => {
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

    it('blocks when no sources at all', () => {
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

    // ── Single-source page_type rules ──

    it('blocks single-source when page_types includes non-ARTICLE', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['AUTHOR_PAGE'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_NON_ARTICLE');
    });

    it('blocks single-source when page_types includes COMMERCIAL_CONTENT', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['COMMERCIAL_CONTENT'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_NON_ARTICLE');
      expect(result.reasons).toContain('SINGLE_SOURCE_COMMERCIAL');
    });

    it('passes single-source when page_types are all ARTICLE', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('passes single-source when page_types is empty (backward compat)', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: [],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('passes single-source when page_types is omitted (backward compat)', () => {
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

    it('blocks single-source when title_alignment below threshold', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        title_alignment: 0.10,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_LOW_TITLE_ALIGN');
    });

    it('passes single-source when title_alignment meets threshold', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        title_alignment: 0.25,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('passes single-source when title_alignment is null (not computed)', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        title_alignment: null,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('does NOT apply single-source rules to multi-source events', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 3,
        total_usable_text_len: 2000,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['COMMERCIAL_CONTENT', 'ARTICLE'],
        title_alignment: 0.05,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('multi');
    });

    // ── Single-source importance gate ──

    it('blocks single-source when importance_score below threshold', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        importance_score: 0.20,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_LOW_IMPORTANCE');
    });

    it('blocks single-source when text below GATE_SINGLE_MIN_TEXT_LEN', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        importance_score: 0.60,
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_SHORT_TEXT');
    });

    it('passes single-source with sufficient text and high importance', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 1500,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        importance_score: 0.60,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('skips importance gate when importance_score is null (backward compat)', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
        importance_score: null,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('skips importance gate when importance_score is omitted', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 1,
        total_usable_text_len: 900,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        page_types: ['ARTICLE'],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('does NOT apply importance gate to multi-source events', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 3,
        total_usable_text_len: 2000,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        importance_score: 0.10,
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('multi');
    });
  });

  // ── computeImportanceScore ──

  describe('computeImportanceScore', () => {
    it('scores fresh POLITICA article high', () => {
      const score = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 2000,
        hours_since_published: 3,
      });
      // recency=1.0, text=0.667, topic=0.9 → 0.4+0.2+0.27 = 0.87
      expect(score).toBeGreaterThan(0.80);
    });

    it('scores old OTROS article low', () => {
      const score = computeImportanceScore({
        topic_key: 'OTROS',
        text_len: 500,
        hours_since_published: 72,
      });
      // recency=0.2, text=0.167, topic=0.2 → 0.08+0.05+0.06 = 0.19
      expect(score).toBeLessThan(0.35);
    });

    it('returns moderate score for mid-age DEPORTES article', () => {
      const score = computeImportanceScore({
        topic_key: 'DEPORTES',
        text_len: 1500,
        hours_since_published: 18,
      });
      // recency=0.6, text=0.5, topic=0.8 → 0.24+0.15+0.24 = 0.63
      expect(score).toBeGreaterThan(0.50);
      expect(score).toBeLessThan(0.80);
    });

    it('uses default recency when hours_since_published is null', () => {
      const score = computeImportanceScore({
        topic_key: 'ECONOMIA',
        text_len: 2000,
        hours_since_published: null,
      });
      // recency=0.3, text=0.667, topic=0.75 → 0.12+0.2+0.225 = 0.545
      expect(score).toBeGreaterThan(0.40);
      expect(score).toBeLessThan(0.70);
    });

    it('caps text_signal at 1.0 for very long text', () => {
      const score = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 10000,
        hours_since_published: 1,
      });
      // recency=1.0, text=1.0, topic=0.9 → 0.4+0.3+0.27 = 0.97
      expect(score).toBeGreaterThan(0.90);
      expect(score).toBeLessThanOrEqual(1.0);
    });
  });
});
