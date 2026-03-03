import { describe, it, expect } from 'vitest';
import { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview, evaluatePublishGate, computeImportanceScore, computeDemotionMultiplier } from './gates.js';

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

  // ── computeImportanceScore v2 ──

  describe('computeImportanceScore — single-source', () => {
    it('scores fresh POLITICA single-source high', () => {
      const score = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 2000,
        hours_since_published: 3,
        unique_sources_count: 1,
      });
      // single: 0.4*1.0 + 0.3*0.667 + 0.3*0.9 = 0.4+0.2+0.27 = 0.87
      expect(score).toBeGreaterThan(0.80);
    });

    it('scores old OTROS single-source very low (harsh penalty)', () => {
      const score = computeImportanceScore({
        topic_key: 'OTROS',
        text_len: 500,
        hours_since_published: 72,
        unique_sources_count: 1,
      });
      // single: 0.4*0.2 + 0.3*0.167 + 0.3*0.10 = 0.08+0.05+0.03 = 0.16
      expect(score).toBeLessThan(0.20);
    });

    it('penalizes OPINION harder in single-source', () => {
      const score = computeImportanceScore({
        topic_key: 'OPINION',
        text_len: 1500,
        hours_since_published: 6,
        unique_sources_count: 1,
      });
      // single: 0.4*0.8 + 0.3*0.5 + 0.3*0.15 = 0.32+0.15+0.045 = 0.515
      expect(score).toBeLessThan(0.55);
      expect(score).toBeGreaterThan(0.40);
    });

    it('defaults to single-source when unique_sources_count omitted', () => {
      const score = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 2000,
        hours_since_published: 3,
      });
      // Same as single-source
      expect(score).toBeGreaterThan(0.80);
    });
  });

  describe('computeImportanceScore — multi-source', () => {
    it('boosts multi-source events via diversity signal', () => {
      const multi = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 2000,
        hours_since_published: 3,
        unique_sources_count: 4,
      });
      // multi: 0.2*1.0 + 0.25*0.667 + 0.25*0.9 + 0.3*1.0 = 0.2+0.167+0.225+0.3 = 0.892
      expect(multi).toBeGreaterThan(0.85);
    });

    it('multi-source OTROS scores higher than single-source OTROS (diversity helps)', () => {
      const multi = computeImportanceScore({
        topic_key: 'OTROS',
        text_len: 1500,
        hours_since_published: 24,
        unique_sources_count: 3,
      });
      const single = computeImportanceScore({
        topic_key: 'OTROS',
        text_len: 1500,
        hours_since_published: 24,
        unique_sources_count: 1,
      });
      expect(multi).toBeGreaterThan(single);
    });

    it('multi-source lowers recency weight (old multi-source still viable)', () => {
      const multi = computeImportanceScore({
        topic_key: 'POLITICA',
        text_len: 2000,
        hours_since_published: 72,
        unique_sources_count: 4,
      });
      // multi: 0.2*0.2 + 0.25*0.667 + 0.25*0.9 + 0.3*1.0 = 0.04+0.167+0.225+0.3 = 0.732
      expect(multi).toBeGreaterThan(0.70);
    });

    it('diversity signal caps at 4 sources', () => {
      const four = computeImportanceScore({
        topic_key: 'ECONOMIA',
        text_len: 2000,
        hours_since_published: 12,
        unique_sources_count: 4,
      });
      const eight = computeImportanceScore({
        topic_key: 'ECONOMIA',
        text_len: 2000,
        hours_since_published: 12,
        unique_sources_count: 8,
      });
      // Both cap diversity at 1.0 → same score
      expect(four).toBe(eight);
    });

    it('uses default recency when hours_since_published is null', () => {
      const score = computeImportanceScore({
        topic_key: 'ECONOMIA',
        text_len: 2000,
        hours_since_published: null,
        unique_sources_count: 3,
      });
      expect(score).toBeGreaterThan(0.40);
      expect(score).toBeLessThan(0.80);
    });
  });

  // ── Single-source topic allowlist gate ──

  describe('evaluatePublishGate — topic allowlist gate', () => {
    const baseSingleSource = {
      unique_sources_count: 1,
      total_usable_text_len: 2000,
      key_facts_count: 0,
      overview_status: 'pending' as const,
      has_disclaimer: false,
      page_types: ['ARTICLE'] as string[],
      importance_score: 0.60,
    };

    it('blocks single-source with disallowed topic and high confidence', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'ENTRETENIMIENTO',
        topic_confidence: 0.85,
        allowed_topics: ['POLITICA', 'ECONOMIA', 'CRIMEN_SEGURIDAD'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_DISALLOWED_TOPIC');
    });

    it('allows single-source with disallowed topic but LOW confidence (< 0.6)', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'ENTRETENIMIENTO',
        topic_confidence: 0.45,
        allowed_topics: ['POLITICA', 'ECONOMIA'],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('allows single-source when topic IS in allowed list', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'POLITICA',
        topic_confidence: 0.90,
        allowed_topics: ['POLITICA', 'ECONOMIA'],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('skips topic gate when allowed_topics is empty (backward compat)', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'ENTRETENIMIENTO',
        topic_confidence: 0.90,
        allowed_topics: [],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('single');
    });

    it('skips topic gate when allowed_topics is omitted', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'ENTRETENIMIENTO',
        topic_confidence: 0.90,
      });
      expect(result.eligible).toBe(true);
    });

    it('skips topic gate when topic_key is null', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: null,
        topic_confidence: 0.90,
        allowed_topics: ['POLITICA'],
      });
      expect(result.eligible).toBe(true);
    });

    it('does NOT apply topic gate to multi-source events', () => {
      const result = evaluatePublishGate({
        unique_sources_count: 3,
        total_usable_text_len: 2000,
        key_facts_count: 0,
        overview_status: 'pending',
        has_disclaimer: false,
        topic_key: 'ENTRETENIMIENTO',
        topic_confidence: 0.95,
        allowed_topics: ['POLITICA'],
      });
      expect(result.eligible).toBe(true);
      expect(result.gate_name).toBe('multi');
    });

    it('blocks at exact confidence threshold (0.6)', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'OTROS',
        topic_confidence: 0.6,
        allowed_topics: ['POLITICA'],
      });
      expect(result.eligible).toBe(false);
      expect(result.reasons).toContain('SINGLE_SOURCE_DISALLOWED_TOPIC');
    });

    it('allows just below confidence threshold (0.59)', () => {
      const result = evaluatePublishGate({
        ...baseSingleSource,
        topic_key: 'OTROS',
        topic_confidence: 0.59,
        allowed_topics: ['POLITICA'],
      });
      expect(result.eligible).toBe(true);
    });
  });

  // ── Demotion multiplier ──

  describe('computeDemotionMultiplier', () => {
    it('returns 1.0 for multi-source events (no demotion)', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 3,
        topic_confidence: 0.4,
        topic_key: 'OPINION',
        total_usable_text_len: 500,
      });
      expect(result.multiplier).toBe(1.0);
      expect(result.reasons).toHaveLength(0);
    });

    it('applies SINGLE_SOURCE demotion (*0.65)', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
      });
      expect(result.multiplier).toBe(0.65);
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).not.toContain('LOW_TOPIC_CONFIDENCE');
    });

    it('stacks SINGLE_SOURCE + LOW_TOPIC_CONFIDENCE (*0.65 * 0.85)', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.45,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
      });
      expect(result.multiplier).toBeCloseTo(0.65 * 0.85, 2);
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).toContain('LOW_TOPIC_CONFIDENCE');
    });

    it('stacks SINGLE_SOURCE + OPINION_CONTENT (*0.65 * 0.70)', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'OPINION',
        total_usable_text_len: 2000,
      });
      expect(result.multiplier).toBeCloseTo(0.65 * 0.70, 2);
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).toContain('OPINION_CONTENT');
    });

    it('stacks SINGLE_SOURCE + SHORT_TEXT (*0.65 * 0.60)', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 800,
      });
      expect(result.multiplier).toBeCloseTo(0.65 * 0.60, 2);
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).toContain('SHORT_TEXT');
    });

    it('stacks all four demotions', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.3,
        topic_key: 'OPINION',
        total_usable_text_len: 500,
      });
      expect(result.multiplier).toBeCloseTo(0.65 * 0.85 * 0.70 * 0.60, 2);
      expect(result.reasons).toHaveLength(4);
    });

    it('no LOW_TOPIC_CONFIDENCE when topic_confidence is null', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: null,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
      });
      expect(result.reasons).not.toContain('LOW_TOPIC_CONFIDENCE');
      expect(result.multiplier).toBe(0.65);
    });

    it('text at exactly 1200 does NOT trigger SHORT_TEXT', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 1200,
      });
      expect(result.reasons).not.toContain('SHORT_TEXT');
    });

    it('text at 1199 triggers SHORT_TEXT', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 1199,
      });
      expect(result.reasons).toContain('SHORT_TEXT');
    });

    // ── v2.3: maybe_link_toxic demotion ──

    it('maybe_link_toxic=true applies ×0.50 demotion on single-source', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
        maybe_link_toxic: true,
      });
      expect(result.reasons).toContain('MAYBE_LINK_TOXIC');
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.multiplier).toBeCloseTo(0.50 * 0.65, 2);
    });

    it('maybe_link_toxic=true applies ×0.50 demotion on multi-source', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 3,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
        maybe_link_toxic: true,
      });
      expect(result.reasons).toContain('MAYBE_LINK_TOXIC');
      expect(result.reasons).not.toContain('SINGLE_SOURCE');
      expect(result.multiplier).toBe(0.5);
    });

    it('maybe_link_toxic=false does NOT apply toxic demotion', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 3,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
        maybe_link_toxic: false,
      });
      expect(result.reasons).not.toContain('MAYBE_LINK_TOXIC');
      expect(result.multiplier).toBe(1.0);
    });

    it('maybe_link_toxic=undefined does NOT apply toxic demotion', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 3,
        topic_confidence: 0.9,
        topic_key: 'POLITICA',
        total_usable_text_len: 2000,
      });
      expect(result.reasons).not.toContain('MAYBE_LINK_TOXIC');
      expect(result.multiplier).toBe(1.0);
    });

    it('maybe_link_toxic stacks with all single-source demotions', () => {
      const result = computeDemotionMultiplier({
        unique_sources_count: 1,
        topic_confidence: 0.3,
        topic_key: 'OPINION',
        total_usable_text_len: 500,
        maybe_link_toxic: true,
      });
      expect(result.reasons).toContain('MAYBE_LINK_TOXIC');
      expect(result.reasons).toContain('SINGLE_SOURCE');
      expect(result.reasons).toContain('LOW_TOPIC_CONFIDENCE');
      expect(result.reasons).toContain('OPINION_CONTENT');
      expect(result.reasons).toContain('SHORT_TEXT');
      expect(result.multiplier).toBeCloseTo(0.50 * 0.65 * 0.85 * 0.70 * 0.60, 2);
    });
  });
});
