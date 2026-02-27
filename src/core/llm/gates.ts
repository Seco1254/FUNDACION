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
const GATE_SINGLE_TITLE_ALIGN_MIN = parseFloat(process.env.GATE_SINGLE_TITLE_ALIGN_MIN ?? '0.20');
const GATE_SINGLE_MIN_TEXT_LEN = parseInt(process.env.GATE_SINGLE_MIN_TEXT_LEN ?? '1200', 10);
const GATE_SINGLE_MIN_IMPORTANCE = parseFloat(process.env.GATE_SINGLE_MIN_IMPORTANCE_SCORE ?? '0.35');

export interface PublishGateInput {
  unique_sources_count: number;
  total_usable_text_len: number;
  key_facts_count: number;
  overview_status: string;
  has_disclaimer: boolean;
  /** Optional: page_types of articles in the event (e.g. ['ARTICLE','COMMERCIAL_CONTENT']). */
  page_types?: string[];
  /** Optional: title_alignment score from coherence metrics (0..1). */
  title_alignment?: number | null;
  /** Optional: heuristic importance score (0..1). When provided, enables single-source importance gate. */
  importance_score?: number | null;
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

  // Gate Single: single-source event — stricter rules to prevent junk in feed
  if (input.unique_sources_count >= 1 && input.unique_sources_count < GATE_MULTI_SOURCES) {
    // Block non-article page types (defense-in-depth; pipeline blocks these earlier)
    const pageTypes = input.page_types ?? [];
    if (pageTypes.length > 0) {
      const hasNonArticle = pageTypes.some((pt) => pt !== 'ARTICLE');
      if (hasNonArticle) {
        reasons.push('SINGLE_SOURCE_NON_ARTICLE');
      }
      const hasCommercial = pageTypes.some((pt) => pt === 'COMMERCIAL_CONTENT');
      if (hasCommercial) {
        reasons.push('SINGLE_SOURCE_COMMERCIAL');
      }
    }

    // Title alignment: block single-source events with poor title alignment
    if (
      input.title_alignment != null &&
      input.title_alignment < GATE_SINGLE_TITLE_ALIGN_MIN
    ) {
      reasons.push('SINGLE_SOURCE_LOW_TITLE_ALIGN');
    }

    // Importance gate: only applied when importance_score is provided (backward compat)
    if (input.importance_score != null) {
      if (input.total_usable_text_len < GATE_SINGLE_MIN_TEXT_LEN) {
        reasons.push('SINGLE_SOURCE_SHORT_TEXT');
      }
      if (input.importance_score < GATE_SINGLE_MIN_IMPORTANCE) {
        reasons.push('SINGLE_SOURCE_LOW_IMPORTANCE');
      }
    }

    if (reasons.length === 0) {
      return { eligible: true, gate_name: 'single', reasons: [] };
    }
    return { eligible: false, gate_name: null, reasons };
  }

  // Fallback: single source >= 1 (when GATE_MULTI_SOURCES is 1, handled above)
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

// ── IMPORTANCE SCORE ──────────────────────────────────────────────────

const IMPORTANCE_TOPIC_WEIGHTS: Record<string, number> = {
  POLITICA: 0.9,
  CRIMEN_SEGURIDAD: 0.85,
  DEPORTES: 0.8,
  ECONOMIA: 0.75,
  SALUD: 0.7,
  MEDIO_AMBIENTE: 0.65,
  ENTRETENIMIENTO: 0.5,
  OPINION: 0.3,
  OTROS: 0.2,
};

/**
 * Compute a heuristic importance score (0..1) for an event.
 * Used by the single-source gate to filter low-value content.
 *
 * Factors:
 *  - 40% recency   (fresher content scores higher)
 *  - 30% text_len  (longer, more substantive text scores higher)
 *  - 30% topic     (hard-news topics score higher)
 */
export function computeImportanceScore(input: {
  topic_key: string;
  text_len: number;
  hours_since_published: number | null;
}): number {
  // Recency signal
  let recency = 0.3; // default for unknown age
  if (input.hours_since_published != null) {
    const h = input.hours_since_published;
    if (h < 6) recency = 1.0;
    else if (h < 12) recency = 0.8;
    else if (h < 24) recency = 0.6;
    else if (h < 48) recency = 0.4;
    else recency = 0.2;
  }

  // Text signal: longer text = more substance (capped at 3000 chars)
  const textSignal = Math.min(input.text_len / 3000, 1.0);

  // Topic signal: hard news topics boost
  const topicSignal = IMPORTANCE_TOPIC_WEIGHTS[input.topic_key] ?? 0.2;

  const score = 0.4 * recency + 0.3 * textSignal + 0.3 * topicSignal;
  return Math.round(score * 1000) / 1000;
}
