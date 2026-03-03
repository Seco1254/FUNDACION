import { describe, it, expect } from 'vitest';
import { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview, evaluatePublishGate, computeImportanceScore, computeDemotionMultiplier, computePublicImportanceV3 } from './gates.js';

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

  // ── computePublicImportanceV3 (topic-first ranking) ──

  describe('computePublicImportanceV3', () => {
    const baseInput = {
      topic_key: 'POLITICA',
      topic_confidence: 0.85,
      num_sources_unique: 4,
      num_articles: 10,
      momentum_6h: 5,
      demotion_multiplier: 1.0,
    };

    it('POLITICA with high confidence gets highest topic weight (1.00)', () => {
      const result = computePublicImportanceV3(baseInput);
      expect(result.components.topic_weight).toBe(1.0);
      // raw = 0.55*1.0 + 0.20*1.0 + 0.15*coverage + 0.10*0.5
      expect(result.raw).toBeGreaterThan(0.80);
      expect(result.final).toBe(result.raw); // demotion=1.0
    });

    it('ECONOMIA gets topic weight 0.92', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'ECONOMIA' });
      expect(result.components.topic_weight).toBe(0.92);
    });

    it('CRIMEN_SEGURIDAD gets topic weight 0.88', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'CRIMEN_SEGURIDAD' });
      expect(result.components.topic_weight).toBe(0.88);
    });

    it('DEPORTES gets topic weight 0.65', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'DEPORTES' });
      expect(result.components.topic_weight).toBe(0.65);
    });

    it('OPINION guardrail forces topic weight to 0.15 regardless of confidence', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'OPINION', topic_confidence: 0.99 });
      expect(result.components.topic_weight).toBe(0.15);
    });

    it('OPINION guardrail still 0.15 even with low confidence', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'OPINION', topic_confidence: 0.30 });
      expect(result.components.topic_weight).toBe(0.15);
    });

    it('low confidence (<0.6) → topic weight 0.45 for any non-OPINION topic', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'POLITICA', topic_confidence: 0.50 });
      expect(result.components.topic_weight).toBe(0.45);
    });

    it('confidence exactly 0.6 uses normal topic weight (not low-confidence)', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'POLITICA', topic_confidence: 0.60 });
      expect(result.components.topic_weight).toBe(1.0);
    });

    it('confidence 0.59 uses low-confidence weight 0.45', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'POLITICA', topic_confidence: 0.59 });
      expect(result.components.topic_weight).toBe(0.45);
    });

    it('unknown topic falls back to OTROS weight (0.30)', () => {
      const result = computePublicImportanceV3({ ...baseInput, topic_key: 'UNKNOWN_TOPIC', topic_confidence: 0.80 });
      expect(result.components.topic_weight).toBe(0.30);
    });

    it('diversity score = min(1, sources/4)', () => {
      expect(computePublicImportanceV3({ ...baseInput, num_sources_unique: 2 }).components.diversity_score).toBe(0.5);
      expect(computePublicImportanceV3({ ...baseInput, num_sources_unique: 4 }).components.diversity_score).toBe(1.0);
      expect(computePublicImportanceV3({ ...baseInput, num_sources_unique: 8 }).components.diversity_score).toBe(1.0);
      expect(computePublicImportanceV3({ ...baseInput, num_sources_unique: 1 }).components.diversity_score).toBe(0.25);
    });

    it('coverage score = log(1+n)/log(21), capped at 1', () => {
      const result1 = computePublicImportanceV3({ ...baseInput, num_articles: 1 });
      expect(result1.components.coverage_score).toBeCloseTo(Math.log(2) / Math.log(21), 2);
      const result20 = computePublicImportanceV3({ ...baseInput, num_articles: 20 });
      expect(result20.components.coverage_score).toBe(1.0);
      const result50 = computePublicImportanceV3({ ...baseInput, num_articles: 50 });
      expect(result50.components.coverage_score).toBe(1.0);
    });

    it('momentum score = min(1, momentum_6h/10)', () => {
      expect(computePublicImportanceV3({ ...baseInput, momentum_6h: 0 }).components.momentum_score).toBe(0);
      expect(computePublicImportanceV3({ ...baseInput, momentum_6h: 5 }).components.momentum_score).toBe(0.5);
      expect(computePublicImportanceV3({ ...baseInput, momentum_6h: 10 }).components.momentum_score).toBe(1.0);
      expect(computePublicImportanceV3({ ...baseInput, momentum_6h: 20 }).components.momentum_score).toBe(1.0);
    });

    it('final = raw * demotion_multiplier', () => {
      const result = computePublicImportanceV3({ ...baseInput, demotion_multiplier: 0.50 });
      expect(result.final).toBeCloseTo(result.raw * 0.50, 2);
    });

    it('toxic demotion (×0.50) halves the v3 final score', () => {
      const normal = computePublicImportanceV3(baseInput);
      const toxic = computePublicImportanceV3({ ...baseInput, demotion_multiplier: 0.50 });
      expect(toxic.final).toBeCloseTo(normal.raw * 0.50, 2);
      expect(toxic.raw).toBe(normal.raw); // raw unchanged
    });

    it('POLITICA ranks higher than DEPORTES with same features', () => {
      const pol = computePublicImportanceV3({ ...baseInput, topic_key: 'POLITICA' });
      const dep = computePublicImportanceV3({ ...baseInput, topic_key: 'DEPORTES' });
      expect(pol.raw).toBeGreaterThan(dep.raw);
    });

    it('DEPORTES ranks higher than OPINION with same features', () => {
      const dep = computePublicImportanceV3({ ...baseInput, topic_key: 'DEPORTES' });
      const opi = computePublicImportanceV3({ ...baseInput, topic_key: 'OPINION' });
      expect(dep.raw).toBeGreaterThan(opi.raw);
    });

    it('all components are bounded [0,1]', () => {
      const result = computePublicImportanceV3(baseInput);
      expect(result.components.topic_weight).toBeGreaterThanOrEqual(0);
      expect(result.components.topic_weight).toBeLessThanOrEqual(1);
      expect(result.components.diversity_score).toBeGreaterThanOrEqual(0);
      expect(result.components.diversity_score).toBeLessThanOrEqual(1);
      expect(result.components.coverage_score).toBeGreaterThanOrEqual(0);
      expect(result.components.coverage_score).toBeLessThanOrEqual(1);
      expect(result.components.momentum_score).toBeGreaterThanOrEqual(0);
      expect(result.components.momentum_score).toBeLessThanOrEqual(1);
    });

    it('raw score is bounded [0,1] since all weights sum to 1', () => {
      // Maximum: all components = 1.0 → raw = 0.55+0.20+0.15+0.10 = 1.0
      const max = computePublicImportanceV3({
        topic_key: 'POLITICA', topic_confidence: 0.99,
        num_sources_unique: 10, num_articles: 50, momentum_6h: 20,
        demotion_multiplier: 1.0,
      });
      expect(max.raw).toBeLessThanOrEqual(1.0);
      expect(max.raw).toBeGreaterThan(0.95);

      // Minimum: topic=OPINION(0.15), 0 sources, 0 articles, 0 momentum
      const min = computePublicImportanceV3({
        topic_key: 'OPINION', topic_confidence: 0.99,
        num_sources_unique: 0, num_articles: 0, momentum_6h: 0,
        demotion_multiplier: 1.0,
      });
      expect(min.raw).toBeGreaterThanOrEqual(0);
      expect(min.raw).toBeLessThan(0.15);
    });

    it('formula weights sum to 1.0', () => {
      // Verify: 0.55 + 0.20 + 0.15 + 0.10 = 1.0
      expect(0.55 + 0.20 + 0.15 + 0.10).toBeCloseTo(1.0, 10);
    });
  });
});
