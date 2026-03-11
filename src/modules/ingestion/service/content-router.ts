/**
 * Content-Type Routing — deterministic routing of articles into
 * NEWS / LOW_CONFIDENCE / NON_NEWS buckets before clustering.
 *
 * Runs after content classification, before embedding + event linker.
 * 0 LLM calls — pure heuristics only.
 */

import { RoutingDecision } from '../../articles/domain/types.js';

export interface RoutingInput {
  contentType: string | null;
  textContentLen: number | null;
  title: string;
  usableForOverview: boolean;
}

// ── Hard NON_NEWS title patterns ─────────────────────────────────────
const NON_NEWS_TITLE_PATTERNS: RegExp[] = [
  /^Quién(es)?\s+somos/i,
  /^Política\s+de/i,
  /^Inscripciones/i,
  /^Edición\s+del/i,
  /^Descargue/i,
  /^Encuentro/i,
];

/**
 * Evaluate the routing decision for an article.
 *
 * Rules (evaluated in order):
 *
 * HARD NON_NEWS:
 *   - content_type === 'institutional_static'
 *   - OR text_content_len < 300
 *   - OR title matches a non-news pattern
 *   - OR usable_for_overview === false
 *   → NON_NEWS
 *
 * SOFT LOW_CONFIDENCE:
 *   - content_type === 'institutional'
 *   - OR content_type === 'opinion'
 *   - OR text_content_len < 600
 *   → LOW_CONFIDENCE
 *
 * Else:
 *   → NEWS
 */
export function evaluateRoutingDecision(input: RoutingInput): RoutingDecision {
  const { contentType, textContentLen, title, usableForOverview } = input;
  const len = textContentLen ?? 0;

  // ── Hard NON_NEWS ──────────────────────────────────────────────────
  if (contentType === 'institutional_static') return 'NON_NEWS';
  if (len < 300) return 'NON_NEWS';
  if (NON_NEWS_TITLE_PATTERNS.some((re) => re.test(title))) return 'NON_NEWS';
  if (!usableForOverview) return 'NON_NEWS';

  // ── Soft LOW_CONFIDENCE ────────────────────────────────────────────
  if (contentType === 'institutional') return 'LOW_CONFIDENCE';
  if (contentType === 'opinion') return 'LOW_CONFIDENCE';
  if (len < 600) return 'LOW_CONFIDENCE';

  // ── Default: NEWS ──────────────────────────────────────────────────
  return 'NEWS';
}
