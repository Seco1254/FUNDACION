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
const GATE_SINGLE_MIN_TEXT_LEN = parseInt(process.env.GATE_SINGLE_MIN_TEXT_LEN ?? '1500', 10);
const GATE_SINGLE_MIN_IMPORTANCE = parseFloat(process.env.GATE_SINGLE_MIN_IMPORTANCE_SCORE ?? '0.45');
const GATE_SINGLE_TOPIC_CONFIDENCE_MIN = parseFloat(process.env.GATE_SINGLE_TOPIC_CONFIDENCE_MIN ?? '0.6');

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
  /** Optional: topic key for single-source topic gate. */
  topic_key?: string | null;
  /** Optional: topic confidence (0..1). */
  topic_confidence?: number | null;
  /** Optional: allowed topic keys (if empty, topic gate is disabled). */
  allowed_topics?: string[];
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

    // Topic allowlist gate: block disallowed topics with high confidence
    const allowedTopics = input.allowed_topics ?? [];
    if (allowedTopics.length > 0 && input.topic_key) {
      if (!allowedTopics.includes(input.topic_key)) {
        if ((input.topic_confidence ?? 0) >= GATE_SINGLE_TOPIC_CONFIDENCE_MIN) {
          reasons.push('SINGLE_SOURCE_DISALLOWED_TOPIC');
        }
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

// ── DEMOTION MULTIPLIERS ─────────────────────────────────────────────

const DEMOTION_SINGLE_SOURCE = parseFloat(process.env.DEMOTION_SINGLE_SOURCE ?? '0.65');
const DEMOTION_LOW_TOPIC_CONF = parseFloat(process.env.DEMOTION_LOW_TOPIC_CONF ?? '0.85');
const DEMOTION_OPINION = parseFloat(process.env.DEMOTION_OPINION ?? '0.70');
const DEMOTION_SHORT_TEXT = parseFloat(process.env.DEMOTION_SHORT_TEXT ?? '0.60');
const DEMOTION_SHORT_TEXT_THRESHOLD = parseInt(process.env.DEMOTION_SHORT_TEXT_THRESHOLD ?? '1200', 10);
const DEMOTION_MAYBE_LINK_TOXIC = parseFloat(process.env.DEMOTION_MAYBE_LINK_TOXIC ?? '0.50');
export const FEED_MAYBE_LINK_TOXIC_DEMOTION_ENABLED = process.env.FEED_MAYBE_LINK_TOXIC_DEMOTION_ENABLED !== '0';

export interface DemotionResult {
  multiplier: number;
  reasons: string[];
}

/**
 * Compute a demotion multiplier (0..1) for feed ranking.
 * Applied AFTER the publish gate — only affects ordering, not eligibility.
 * Multi-source events (>=2 sources) are NOT demoted.
 */
export function computeDemotionMultiplier(input: {
  unique_sources_count: number;
  topic_confidence?: number | null;
  topic_key?: string | null;
  total_usable_text_len: number;
  /** v2.3: when true and FEED_MAYBE_LINK_TOXIC_DEMOTION_ENABLED, apply ×0.50 extra demotion */
  maybe_link_toxic?: boolean;
}): DemotionResult {
  const reasons: string[] = [];
  let multiplier = 1.0;

  // v2.3: Maybe-link toxic demotion (applies to ANY event, not just single-source)
  if (input.maybe_link_toxic && FEED_MAYBE_LINK_TOXIC_DEMOTION_ENABLED) {
    multiplier *= DEMOTION_MAYBE_LINK_TOXIC;
    reasons.push('MAYBE_LINK_TOXIC');
  }

  // Only apply single-source demotions to single-source events
  if (input.unique_sources_count >= 2) {
    if (reasons.length === 0) return { multiplier: 1.0, reasons: [] };
    return { multiplier: Math.round(multiplier * 1000) / 1000, reasons };
  }

  // Single-source demotion
  multiplier *= DEMOTION_SINGLE_SOURCE;
  reasons.push('SINGLE_SOURCE');

  // Low topic confidence
  if (input.topic_confidence != null && input.topic_confidence < GATE_SINGLE_TOPIC_CONFIDENCE_MIN) {
    multiplier *= DEMOTION_LOW_TOPIC_CONF;
    reasons.push('LOW_TOPIC_CONFIDENCE');
  }

  // Opinion content (topic_key = OPINION)
  if (input.topic_key === 'OPINION') {
    multiplier *= DEMOTION_OPINION;
    reasons.push('OPINION_CONTENT');
  }

  // Short text
  if (input.total_usable_text_len < DEMOTION_SHORT_TEXT_THRESHOLD) {
    multiplier *= DEMOTION_SHORT_TEXT;
    reasons.push('SHORT_TEXT');
  }

  return { multiplier: Math.round(multiplier * 1000) / 1000, reasons };
}

// ── PUBLIC IMPORTANCE V3 (Topic-First) ───────────────────────────────

const TOPIC_WEIGHT_V3: Record<string, number> = {
  POLITICA: 1.00,
  ECONOMIA: 0.92,
  CRIMEN_SEGURIDAD: 0.88,
  SALUD: 0.75,
  MEDIO_AMBIENTE: 0.70,
  DEPORTES: 0.65,
  ENTRETENIMIENTO: 0.45,
  OPINION: 0.15,
  OTROS: 0.30,
};

const TOPIC_WEIGHT_V3_LOW_CONFIDENCE = 0.45;
const TOPIC_CONFIDENCE_THRESHOLD_V3 = 0.60;
const OPINION_GUARDRAIL_WEIGHT = 0.15;

// Weights: 55% topic, 20% diversity, 15% coverage, 10% momentum
const W_TOPIC_V3 = 0.55;
const W_DIVERSITY_V3 = 0.20;
const W_COVERAGE_V3 = 0.15;
const W_MOMENTUM_V3 = 0.10;

export interface PublicImportanceV3Input {
  topic_key: string;
  topic_confidence: number;
  num_sources_unique: number;
  num_articles: number;
  momentum_6h: number;
  demotion_multiplier: number;
}

export interface PublicImportanceV3Result {
  raw: number;
  final: number;
  components: {
    topic_weight: number;
    diversity_score: number;
    coverage_score: number;
    momentum_score: number;
  };
}

/**
 * Compute public importance v3 with topic-first ranking.
 *
 * Formula:
 *   raw = 0.55*TopicWeight + 0.20*DiversityScore + 0.15*CoverageScore + 0.10*MomentumScore
 *   final = raw * demotion_multiplier
 *
 * TopicWeight: lookup by topic_key; OPINION forced to 0.15 regardless.
 * Low confidence (<0.6) → TopicWeight = 0.45.
 * Coverage: log(1 + num_articles) / log(1 + 20), clamped [0,1].
 * Diversity: min(1, num_sources_unique / 4).
 * Momentum: min(1, momentum_6h / 10).
 */
export function computePublicImportanceV3(input: PublicImportanceV3Input): PublicImportanceV3Result {
  // Topic weight: OPINION guardrail always forces 0.15
  let topicWeight: number;
  if (input.topic_key === 'OPINION') {
    topicWeight = OPINION_GUARDRAIL_WEIGHT;
  } else if (input.topic_confidence < TOPIC_CONFIDENCE_THRESHOLD_V3) {
    topicWeight = TOPIC_WEIGHT_V3_LOW_CONFIDENCE;
  } else {
    topicWeight = TOPIC_WEIGHT_V3[input.topic_key] ?? TOPIC_WEIGHT_V3['OTROS'];
  }

  const diversityScore = Math.min(1, input.num_sources_unique / 4);
  const coverageScore = Math.min(1, Math.log(1 + input.num_articles) / Math.log(1 + 20));
  const momentumScore = Math.min(1, input.momentum_6h / 10);

  const raw = W_TOPIC_V3 * topicWeight
    + W_DIVERSITY_V3 * diversityScore
    + W_COVERAGE_V3 * coverageScore
    + W_MOMENTUM_V3 * momentumScore;

  const final = raw * input.demotion_multiplier;

  return {
    raw: Math.round(raw * 1000) / 1000,
    final: Math.round(final * 1000) / 1000,
    components: {
      topic_weight: Math.round(topicWeight * 1000) / 1000,
      diversity_score: Math.round(diversityScore * 1000) / 1000,
      coverage_score: Math.round(coverageScore * 1000) / 1000,
      momentum_score: Math.round(momentumScore * 1000) / 1000,
    },
  };
}

// ── IMPORTANCE SCORE (v1/v2 — legacy, still used by publish gate) ────

// ── Topic weights per gate tier ──────────────────────────────────────

const IMPORTANCE_TOPIC_WEIGHTS_MULTI: Record<string, number> = {
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

const IMPORTANCE_TOPIC_WEIGHTS_SINGLE: Record<string, number> = {
  POLITICA: 0.9,
  CRIMEN_SEGURIDAD: 0.85,
  DEPORTES: 0.8,
  ECONOMIA: 0.75,
  SALUD: 0.7,
  MEDIO_AMBIENTE: 0.65,
  ENTRETENIMIENTO: 0.4,
  OPINION: 0.15,
  OTROS: 0.10,
};

/**
 * Compute a heuristic importance score (0..1) for an event.
 * Used by the single-source gate and for feed ranking signals.
 *
 * Two formulas depending on source diversity:
 *
 * **Multi-source** (unique_sources >= 2):
 *   20% recency + 25% text + 25% topic + 30% diversity
 *   Rewards broader coverage, lowers recency weight to avoid
 *   "anything new" bias.
 *
 * **Single-source** (unique_sources < 2):
 *   40% recency + 30% text + 30% topic
 *   Maintains recency weight but applies harsher OPINION/OTROS penalties.
 */
export function computeImportanceScore(input: {
  topic_key: string;
  text_len: number;
  hours_since_published: number | null;
  unique_sources_count?: number;
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

  const sources = input.unique_sources_count ?? 1;

  let score: number;
  if (sources >= 2) {
    // Multi-source: boost diversity, lower recency
    const topicSignal = IMPORTANCE_TOPIC_WEIGHTS_MULTI[input.topic_key] ?? 0.2;
    const diversitySignal = Math.min(sources / 4, 1.0);
    score = 0.20 * recency + 0.25 * textSignal + 0.25 * topicSignal + 0.30 * diversitySignal;
  } else {
    // Single-source: keep recency, penalize OPINION/OTROS harder
    const topicSignal = IMPORTANCE_TOPIC_WEIGHTS_SINGLE[input.topic_key] ?? 0.10;
    score = 0.40 * recency + 0.30 * textSignal + 0.30 * topicSignal;
  }

  return Math.round(score * 1000) / 1000;
}
