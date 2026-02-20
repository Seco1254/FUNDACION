/**
 * Event Linker v2.1 configuration — all new env vars for gates, two-step, and split detector.
 */

// ── Feature flags ──
export const HARD_NEGATIVE_ENABLED = process.env.EVENT_LINKER_HARD_NEGATIVE_ENABLED !== '0';
export const TWO_STEP_ENABLED = process.env.EVENT_LINKER_TWO_STEP_ENABLED !== '0';
export const SPLIT_DETECTOR_ENABLED = process.env.EVENT_LINKER_SPLIT_DETECTOR_ENABLED !== '0';

// ── Entity gate (enhanced, 2 thresholds) ──
export const AUTO_MIN_ENTITY_JACCARD = parseFloat(process.env.EVENT_LINKER_AUTO_MIN_ENTITY_JACCARD ?? '0.05');
export const MAYBE_MIN_ENTITY_JACCARD = parseFloat(process.env.EVENT_LINKER_MAYBE_MIN_ENTITY_JACCARD ?? '0.01');

// ── Topic gate ──
export const TOPIC_GATE_ENABLED = process.env.EVENT_LINKER_TOPIC_GATE_ENABLED !== '0';
export const TOPIC_TOP1_MUST_MATCH = process.env.EVENT_LINKER_TOPIC_TOP1_MUST_MATCH !== '0';

// ── Title contradiction gate ──
export const TITLE_GATE_ENABLED = process.env.EVENT_LINKER_TITLE_GATE_ENABLED !== '0';
export const TITLE_KEYWORD_JACCARD_MIN = parseFloat(process.env.EVENT_LINKER_TITLE_KEYWORD_JACCARD_MIN ?? '0.06');
export const TITLE_ENTITY_JACCARD_MIN = parseFloat(process.env.EVENT_LINKER_TITLE_ENTITY_JACCARD_MIN ?? '0.01');

// ── Two-step signals ──
export const AUTO_REQUIRES_SIGNALS = parseInt(process.env.EVENT_LINKER_AUTO_REQUIRES_SIGNALS ?? '2', 10);
export const SIGNAL_MIN_EMBED = parseFloat(process.env.EVENT_LINKER_SIGNAL_MIN_EMBED ?? '0.45');
export const SIGNAL_MIN_ENTITY = parseFloat(process.env.EVENT_LINKER_SIGNAL_MIN_ENTITY ?? '0.08');
export const SIGNAL_MIN_TOPIC = parseFloat(process.env.EVENT_LINKER_SIGNAL_MIN_TOPIC ?? '0.25');

// ── Split detector ──
export const SPLIT_MIN_ARTICLES = parseInt(process.env.EVENT_LINKER_SPLIT_MIN_ARTICLES ?? '4', 10);
export const SPLIT_CHECK_COOLDOWN_MIN = parseInt(process.env.EVENT_LINKER_SPLIT_CHECK_COOLDOWN_MIN ?? '10', 10);
export const SPLIT_K = parseInt(process.env.EVENT_LINKER_SPLIT_K ?? '2', 10);
export const SPLIT_MIN_SEPARATION = parseFloat(process.env.EVENT_LINKER_SPLIT_MIN_SEPARATION ?? '0.18');
export const SPLIT_MAX_WITHIN_COHESION = parseFloat(process.env.EVENT_LINKER_SPLIT_MAX_WITHIN_COHESION ?? '0.22');
