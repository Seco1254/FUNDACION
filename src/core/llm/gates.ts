/**
 * Anti-hallucination gates for AI overview generation.
 * Runs BEFORE persisting ai_overview to packet_json.
 */

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
 * Count words in a string (Spanish-aware).
 */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter((w) => w.length > 0).length;
}

const BOILERPLATE_PATTERNS: RegExp[] = [
  /\bsuscr[ií]b[ea]|suscripci[oó]n\b/i,
  /\bnewsletter\b/i,
  /\bcookies?\b/i,
  /\bpublicidad\b/i,
  /\bcompartir en (facebook|twitter|whatsapp)\b/i,
  /\bseguir leyendo\b/i,
  /\bt[eé]rminos y condiciones\b/i,
  /\bpol[ií]tica de privacidad\b/i,
  /\binicia[r]? sesi[oó]n\b/i,
  /\bdescargar la app\b/i,
  /\bderechos reservados\b/i,
];

const MIN_WORDS_PER_BULLET = 15;
const MIN_OVERVIEW_WORDS = 80;

/**
 * Validate the LLM output itself — non-empty arrays + narrative quality checks.
 */
export function validateOverviewContent(aiOverview: {
  overview?: unknown;
  what_happened?: unknown;
  context?: unknown;
  in_dispute?: unknown;
}): EvidenceValidation {
  const reasons: string[] = [];

  const wh = aiOverview.what_happened;
  if (!Array.isArray(wh) || wh.length === 0 || wh.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_WHAT_HAPPENED');
  } else {
    // Narrative quality: each bullet must have >= MIN_WORDS_PER_BULLET words
    const shortBullets = (wh as string[]).filter((s) => typeof s === 'string' && s.trim().length > 0 && countWords(s) < MIN_WORDS_PER_BULLET);
    if (shortBullets.length > 0 && shortBullets.length === wh.length) {
      reasons.push('TELEGRAPHIC_WHAT_HAPPENED');
    }
    // Boilerplate check on what_happened
    const boilerplateBullets = (wh as string[]).filter((s) =>
      typeof s === 'string' && BOILERPLATE_PATTERNS.some((p) => p.test(s)),
    );
    if (boilerplateBullets.length > 0 && boilerplateBullets.length >= (wh.length / 2)) {
      reasons.push('BOILERPLATE_WHAT_HAPPENED');
    }
  }

  const ctx = aiOverview.context;
  if (!Array.isArray(ctx) || ctx.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_CONTEXT');
  }

  const disp = aiOverview.in_dispute;
  if (!Array.isArray(disp) || disp.every((s: unknown) => typeof s !== 'string' || s.trim() === '')) {
    reasons.push('EMPTY_IN_DISPUTE');
  }

  // Overview paragraph quality: must be >= MIN_OVERVIEW_WORDS words
  const overview = aiOverview.overview;
  if (typeof overview === 'string' && overview.trim().length > 0) {
    if (countWords(overview) < MIN_OVERVIEW_WORDS) {
      reasons.push('SHORT_OVERVIEW_PARAGRAPH');
    }
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
const GATE_SINGLE_TEXT = parseInt(process.env.GATE_SINGLE_TEXT ?? '800', 10);
const GATE_KEY_FACTS_MIN = parseInt(process.env.GATE_KEY_FACTS_MIN ?? '0', 10);

export interface PublishGateInput {
  unique_sources_count: number;
  total_usable_text_len: number;
  key_facts_count: number;
  overview_status: string;
  has_disclaimer: boolean;
}

export interface PublishGateResult {
  eligible: boolean;
  gate_name: 'multi' | 'single' | null;
  reasons: string[];
}

/**
 * Hard publish gate: determines if an event is eligible to appear in /v1/feed.
 *
 * Checks RAW EVIDENCE capability (sources, text), not pipeline completion.
 * Events with sufficient evidence pass even if overview hasn't been generated yet
 * (overview_status 'pending'). Only blocks when status is explicitly 'failed'
 * (pipeline ran and determined evidence is insufficient).
 *
 * Gate Multi: sources>=2 AND text>=1200
 * Gate Single: sources>=1 AND text>=800
 * Both:       key_facts >= GATE_KEY_FACTS_MIN (default 0)
 *             NOT overview_status='failed'
 */
export function evaluatePublishGate(input: PublishGateInput): PublishGateResult {
  // Kill switch: PUBLISH_GATE_ENABLED=0 bypasses the gate entirely
  if (!PUBLISH_GATE_ENABLED) {
    return { eligible: true, gate_name: null, reasons: [] };
  }

  const reasons: string[] = [];

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

  // Gate Single: single-source event (no disclaimer requirement for feed eligibility)
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
