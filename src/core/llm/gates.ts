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
