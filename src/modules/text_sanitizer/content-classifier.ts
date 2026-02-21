/**
 * Soft content classifier for detecting institutional/non-news content.
 * Returns a score + reasons — does NOT binary exclude, only lowers priority.
 */

export type ContentType = 'news' | 'institutional' | 'opinion' | 'unknown';

export interface ClassificationResult {
  content_type: ContentType;
  score: number;
  reasons: string[];
}

// ── Institutional patterns ──────────────────────────────────────────

const INSTITUTIONAL_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /convocatoria\s+(abierta|p[uú]blica)/i, label: 'convocatoria_abierta', weight: 0.12 },
  { pattern: /inscripciones?\s+(abiertas?|hasta)/i, label: 'inscripciones', weight: 0.12 },
  { pattern: /fecha\s+l[ií]mite/i, label: 'fecha_limite', weight: 0.10 },
  { pattern: /zoom\.us|meet\.google|teams\.microsoft/i, label: 'enlace_videoconferencia', weight: 0.12 },
  { pattern: /enlace\s+(de\s+)?zoom/i, label: 'enlace_zoom', weight: 0.10 },
  { pattern: /seminario|webinar|taller\s+virtual|coloquio/i, label: 'evento_academico', weight: 0.08 },
  { pattern: /requisitos\s+de\s+participaci[oó]n/i, label: 'requisitos_participacion', weight: 0.12 },
  { pattern: /certificado\s+de\s+asistencia/i, label: 'certificado_asistencia', weight: 0.12 },
  { pattern: /ponentes?\s+invitados?/i, label: 'ponentes_invitados', weight: 0.08 },
  { pattern: /agenda\s+del\s+evento/i, label: 'agenda_evento', weight: 0.08 },
  { pattern: /formulario\s+de\s+(inscripci[oó]n|registro)/i, label: 'formulario_registro', weight: 0.12 },
  { pattern: /congreso\s+(nacional|internacional)/i, label: 'congreso', weight: 0.06 },
  { pattern: /simposio/i, label: 'simposio', weight: 0.08 },
  { pattern: /convocatoria\s+de\s+(empleo|trabajo|becas?)/i, label: 'convocatoria_empleo', weight: 0.12 },
  { pattern: /plazo\s+(de\s+)?(inscripci[oó]n|postulaci[oó]n)/i, label: 'plazo_inscripcion', weight: 0.10 },
];

// ── Reporting verbs (indicate news coverage, not institutional content) ──

const REPORTING_VERBS_RE = /\b(dijo|afirm[oó]|anunci[oó]|denunci[oó]|investigan|capturaron|aprob[oó]|orden[oó]|se[nñ]al[oó]|declar[oó]|revel[oó]|confirm[oó]|alert[oó]|advirti[oó]|rechaz[oó]|critic[oó]|exigi[oó])\b/gi;

// ── Opinion patterns ─────────────────────────────────────────────────

const OPINION_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bcolumna\s+de\s+opini[oó]n\b/i, label: 'columna_opinion', weight: 0.20 },
  { pattern: /\beditorial\b/i, label: 'editorial', weight: 0.15 },
  { pattern: /\bopini[oó]n\b/i, label: 'opinion', weight: 0.10 },
  { pattern: /\ban[aá]lisis\s+de\b/i, label: 'analisis', weight: 0.05 },
];

/**
 * Classify article content as news, institutional, opinion, or unknown.
 * Soft classifier: returns score 0.0-1.0 + reasons, never binary exclusion.
 */
export function classifyContent(text: string): ClassificationResult {
  if (!text || text.trim().length === 0) {
    return { content_type: 'unknown', score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let institutionalScore = 0;
  let opinionScore = 0;

  // Check institutional patterns
  for (const { pattern, label, weight } of INSTITUTIONAL_PATTERNS) {
    if (pattern.test(text)) {
      institutionalScore += weight;
      reasons.push(`institutional:${label}`);
    }
  }

  // Discount for reporting verbs (indicate news coverage OF an event)
  const reportingMatches = text.match(REPORTING_VERBS_RE) ?? [];
  const reportingVerbCount = reportingMatches.length;
  if (reportingVerbCount > 0) {
    const discount = Math.min(reportingVerbCount * 0.15, 0.45);
    institutionalScore = Math.max(0, institutionalScore - discount);
    reasons.push(`reporting_verb_discount:-${discount.toFixed(2)} (${reportingVerbCount} verbs)`);
  }

  // Check opinion patterns
  for (const { pattern, label, weight } of OPINION_PATTERNS) {
    if (pattern.test(text)) {
      opinionScore += weight;
      reasons.push(`opinion:${label}`);
    }
  }

  // Determine type
  if (institutionalScore >= 0.5) {
    return {
      content_type: 'institutional',
      score: Math.min(institutionalScore, 1.0),
      reasons,
    };
  }

  if (opinionScore >= 0.3) {
    return {
      content_type: 'opinion',
      score: Math.min(opinionScore, 1.0),
      reasons,
    };
  }

  // Default: news (or unknown if no signal at all)
  const maxScore = Math.max(institutionalScore, opinionScore);
  if (maxScore === 0 && reasons.length === 0) {
    return { content_type: 'news', score: 0, reasons: [] };
  }

  return {
    content_type: 'news',
    score: maxScore,
    reasons,
  };
}
