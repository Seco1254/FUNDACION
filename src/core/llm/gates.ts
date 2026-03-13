/**
 * Anti-hallucination gates for AI overview generation.
 * Runs BEFORE persisting ai_overview to packet_json.
 */

import { classifyNonNews } from '../../modules/quality/detectors/non-news.js';

export interface EvidenceValidation {
  valid: boolean;
  reasons: string[];
}

/**
 * Validate that there is enough evidence to produce a reliable AI overview.
 * Hard rules:
 *   - >= 2 distinct sources (media keys) in the event
 *   - >= 2 quotes total referenciable
 */
export function validateOverviewEvidence(
  sourcesCount: number,
  quotesCount: number,
): EvidenceValidation {
  const reasons: string[] = [];

  if (sourcesCount < 2) reasons.push('SINGLE_SOURCE');
  if (quotesCount < 2) reasons.push('MISSING_QUOTES');

  return { valid: reasons.length === 0, reasons };
}

/**
 * Validate the LLM output itself — non-empty arrays for key fields.
 */
export function validateOverviewContent(aiOverview: {
  what_happened?: unknown;
  context?: unknown;
  in_dispute?: unknown;
}): EvidenceValidation {
  const reasons: string[] = [];

  const wh = aiOverview.what_happened;
  if (!Array.isArray(wh) || wh.length === 0 || wh.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_WHAT_HAPPENED');
  }

  const ctx = aiOverview.context;
  if (!Array.isArray(ctx) || ctx.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_CONTEXT');
  }

  const disp = aiOverview.in_dispute;
  if (!Array.isArray(disp) || disp.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_IN_DISPUTE');
  }

  return { valid: reasons.length === 0, reasons };
}

/**
 * Build the INSUFFICIENT_EVIDENCE fallback overview.
 */
export function buildInsufficientOverview(reasons: string[]): Record<string, unknown> {
  return {
    overview: '',
    what_happened: ['Evidencia insuficiente para un resumen confiable.'],
    context: [],
    in_dispute: [],
    confidence_label: 'No concluyente',
    why: `Bloqueado por gates: ${reasons.join(', ')}`,
    disputes: [],
    consensus: [],
    status: 'INSUFFICIENT_EVIDENCE',
  };
}

// ── PUBLISH GATE ──────────────────────────────────────────────────────

const PUBLISH_GATE_ENABLED = process.env.PUBLISH_GATE_ENABLED !== '0';
const GATE_MULTI_SOURCES = parseInt(process.env.GATE_MULTI_SOURCES ?? '2', 10);
const GATE_MULTI_TEXT = parseInt(process.env.GATE_MULTI_TEXT ?? '1200', 10);
const GATE_SINGLE_TEXT = parseInt(process.env.GATE_SINGLE_TEXT ?? '1500', 10);
const GATE_KEY_FACTS_MIN = parseInt(process.env.GATE_KEY_FACTS_MIN ?? '0', 10);

export interface PublishGateInput {
  unique_sources_count: number;
  total_usable_text_len: number;
  key_facts_count: number;
  overview_status: string;
  has_disclaimer: boolean;
  /** Headline for non-news classification. Optional for backward compat. */
  headline?: string;
}

export interface PublishGateResult {
  eligible: boolean;
  gate_name: 'multi' | 'single' | null;
  reasons: string[];
}

/**
 * Hard publish gate: determines if an event is eligible to appear in /v1/feed.
 *
 * Checks:
 * 1. Non-news content classifier (headline-based) — hard block
 * 2. RAW EVIDENCE capability (sources, text)
 * 3. Pipeline status (blocks 'failed')
 *
 * Gate Multi: sources>=2 AND text>=1200
 * Gate Single: sources>=1 AND text>=1500 (raised from 800 for feed quality)
 * Both:       key_facts >= GATE_KEY_FACTS_MIN (default 0)
 *             NOT overview_status='failed'
 *             NOT non-news headline
 */
export function evaluatePublishGate(input: PublishGateInput): PublishGateResult {
  // Kill switch: PUBLISH_GATE_ENABLED=0 bypasses the gate entirely
  if (!PUBLISH_GATE_ENABLED) {
    return { eligible: true, gate_name: null, reasons: [] };
  }

  const reasons: string[] = [];

  // ── Non-news headline classification (hard block) ──
  if (input.headline) {
    const nonNews = classifyNonNews(input.headline);
    if (nonNews.isNonNews) {
      reasons.push(`NON_NEWS:${nonNews.reason}`);
      return { eligible: false, gate_name: null, reasons };
    }
  }

  // Only block when the pipeline explicitly failed — NOT when it's still pending
  if (input.overview_status === 'failed') {
    reasons.push('OVERVIEW_FAILED');
  }
  if (input.key_facts_count < GATE_KEY_FACTS_MIN) {
    reasons.push('KEY_FACTS_INSUFFICIENT');
  }
  if (input.total_usable_text_len < GATE_SINGLE_TEXT) {
    reasons.push('TEXT_TOO_SHORT');
  }

  // Gate Multi: multi-source event
  if (input.unique_sources_count >= GATE_MULTI_SOURCES) {
    if (input.total_usable_text_len < GATE_MULTI_TEXT) {
      if (!reasons.includes('TEXT_TOO_SHORT')) reasons.push('TEXT_TOO_SHORT');
    }
    if (reasons.length === 0) {
      return { eligible: true, gate_name: 'multi', reasons: [] };
    }
    return { eligible: false, gate_name: null, reasons };
  }

  // Gate Single: single-source event
  if (input.unique_sources_count >= 1) {
    if (reasons.length === 0) {
      return { eligible: true, gate_name: 'single', reasons: [] };
    }
    return { eligible: false, gate_name: null, reasons };
  }

  // No sources at all
  reasons.push('NO_SOURCES');
  return { eligible: false, gate_name: null, reasons };
}
