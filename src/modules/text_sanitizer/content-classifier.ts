/**
 * Soft content classifier for detecting institutional/non-news content.
 * Returns a score + reasons — does NOT binary exclude, only lowers priority.
 *
 * Content types:
 * - 'news': standard news article with reporting verbs
 * - 'institutional': event/convocatoria (seminario, taller, congreso)
 * - 'institutional_static': evergreen/about pages (quiénes somos, donaciones, equipo)
 * - 'opinion': editorial / opinion column
 * - 'unknown': not enough signal
 */

export type ContentType = 'news' | 'institutional' | 'institutional_static' | 'opinion' | 'unknown';

export interface ClassificationResult {
  content_type: ContentType;
  score: number;
  reasons: string[];
}

export interface ClassificationInput {
  text: string;
  title?: string;
  url?: string;
}

// ── Institutional patterns (convocatorias, seminarios, etc.) ─────────

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

// ── Institutional STATIC patterns (about pages, donations, team bios) ──

const STATIC_TITLE_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bqui[eé]nes\s+somos\b/i, label: 'quienes_somos', weight: 0.40 },
  { pattern: /\bsobre\s+nosotros\b/i, label: 'sobre_nosotros', weight: 0.40 },
  { pattern: /\bacerca\s+de\b/i, label: 'acerca_de', weight: 0.30 },
  { pattern: /\bnuestra?\s+misi[oó]n\b/i, label: 'mision', weight: 0.35 },
  { pattern: /\bnuestra?\s+historia\b/i, label: 'historia', weight: 0.30 },
  { pattern: /\bnuestro\s+equipo\b/i, label: 'equipo', weight: 0.35 },
  { pattern: /\bdonaciones?\b/i, label: 'donaciones', weight: 0.35 },
  { pattern: /\bap[oó]yanos\b/i, label: 'apoyanos', weight: 0.35 },
  { pattern: /\bhaz\s+(una?\s+)?donaci[oó]n\b/i, label: 'haz_donacion', weight: 0.40 },
  { pattern: /\bt[eé]rminos\s+y\s+condiciones\b/i, label: 'terminos', weight: 0.40 },
  { pattern: /\bpol[ií]tica\s+de\s+privacidad\b/i, label: 'privacidad', weight: 0.40 },
];

const STATIC_URL_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\/quienes-somos/i, label: 'url_quienes_somos', weight: 0.35 },
  { pattern: /\/sobre-nosotros/i, label: 'url_sobre_nosotros', weight: 0.35 },
  { pattern: /\/about/i, label: 'url_about', weight: 0.30 },
  { pattern: /\/donaciones/i, label: 'url_donaciones', weight: 0.35 },
  { pattern: /\/donate/i, label: 'url_donate', weight: 0.35 },
  { pattern: /\/team/i, label: 'url_team', weight: 0.30 },
  { pattern: /\/equipo/i, label: 'url_equipo', weight: 0.30 },
  { pattern: /\/fundacion/i, label: 'url_fundacion', weight: 0.20 },
  { pattern: /\/mision/i, label: 'url_mision', weight: 0.30 },
  { pattern: /\/historia/i, label: 'url_historia', weight: 0.25 },
];

const STATIC_TEXT_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bNIT\b\s*[:\.]?\s*\d/i, label: 'nit', weight: 0.25 },
  { pattern: /\bcuenta\s+(corriente|de\s+ahorros)\b/i, label: 'cuenta_bancaria', weight: 0.25 },
  { pattern: /\bda\s+clic\b/i, label: 'da_clic', weight: 0.15 },
  { pattern: /\bdonar\b/i, label: 'donar', weight: 0.15 },
  { pattern: /\bap[oó]yanos\b/i, label: 'apoyanos_text', weight: 0.15 },
  { pattern: /\bhaz\s+(una?\s+)?donaci[oó]n\b/i, label: 'haz_donacion_text', weight: 0.20 },
  { pattern: /\bnuestra\s+misi[oó]n\b/i, label: 'mision_text', weight: 0.15 },
  { pattern: /\bfundada?\s+en\s+\d{4}\b/i, label: 'fundada_en', weight: 0.15 },
  { pattern: /\bdesde\s+\d{4}\b.*\b(trabajamos|dedicamos|promovemos)\b/i, label: 'desde_anio', weight: 0.15 },
  { pattern: /\bjunta\s+directiva\b/i, label: 'junta_directiva', weight: 0.20 },
  { pattern: /\bdirectora?\s+(ejecutiv[oa]|general)\b/i, label: 'director', weight: 0.15 },
  { pattern: /\braz[oó]n\s+social\b/i, label: 'razon_social', weight: 0.20 },
];

// ── Reporting verbs (indicate news coverage, not institutional content) ──

const REPORTING_VERBS_RE = /\b(dijo|afirm[oó]|anunci[oó]|denunci[oó]|investigan|capturaron|aprob[oó]|orden[oó]|se[nñ]al[oó]|declar[oó]|revel[oó]|confirm[oó]|alert[oó]|advirti[oó]|rechaz[oó]|critic[oó]|exigi[oó]|decret[oó]|conden[oó])\b/gi;

// ── Opinion patterns ─────────────────────────────────────────────────

const OPINION_PATTERNS: Array<{ pattern: RegExp; label: string; weight: number }> = [
  { pattern: /\bcolumna\s+de\s+opini[oó]n\b/i, label: 'columna_opinion', weight: 0.20 },
  { pattern: /\beditorial\b/i, label: 'editorial', weight: 0.15 },
  { pattern: /\bopini[oó]n\b/i, label: 'opinion', weight: 0.10 },
  { pattern: /\ban[aá]lisis\s+de\b/i, label: 'analisis', weight: 0.05 },
];

const STATIC_SCORE_THRESHOLD = 0.45;
const INSTITUTIONAL_SCORE_THRESHOLD = 0.5;

/**
 * Classify article content as news, institutional_static, institutional, opinion, or unknown.
 * Accepts either a plain text string (backward compatible) or a ClassificationInput object.
 */
export function classifyContent(input: string | ClassificationInput): ClassificationResult {
  const text = typeof input === 'string' ? input : input.text;
  const title = typeof input === 'string' ? undefined : input.title;
  const url = typeof input === 'string' ? undefined : input.url;

  if (!text || text.trim().length === 0) {
    return { content_type: 'unknown', score: 0, reasons: [] };
  }

  const reasons: string[] = [];
  let institutionalScore = 0;
  let staticScore = 0;
  let opinionScore = 0;

  // ── Check institutional_static patterns (title + URL + text) ──────

  // Title-based signals
  if (title) {
    for (const { pattern, label, weight } of STATIC_TITLE_PATTERNS) {
      if (pattern.test(title)) {
        staticScore += weight;
        reasons.push(`static_title:${label}`);
      }
    }
  }

  // URL-based signals
  if (url) {
    for (const { pattern, label, weight } of STATIC_URL_PATTERNS) {
      if (pattern.test(url)) {
        staticScore += weight;
        reasons.push(`static_url:${label}`);
      }
    }
  }

  // Text-based static signals
  for (const { pattern, label, weight } of STATIC_TEXT_PATTERNS) {
    if (pattern.test(text)) {
      staticScore += weight;
      reasons.push(`static_text:${label}`);
    }
  }

  // ── Check institutional patterns (convocatorias, etc.) ────────────

  for (const { pattern, label, weight } of INSTITUTIONAL_PATTERNS) {
    if (pattern.test(text)) {
      institutionalScore += weight;
      reasons.push(`institutional:${label}`);
    }
  }

  // ── Discount for reporting verbs ──────────────────────────────────

  const reportingMatches = text.match(REPORTING_VERBS_RE) ?? [];
  const reportingVerbCount = reportingMatches.length;
  if (reportingVerbCount > 0) {
    const discount = Math.min(reportingVerbCount * 0.15, 0.45);
    institutionalScore = Math.max(0, institutionalScore - discount);
    staticScore = Math.max(0, staticScore - discount);
    reasons.push(`reporting_verb_discount:-${discount.toFixed(2)} (${reportingVerbCount} verbs)`);
  }

  // ── Check opinion patterns ────────────────────────────────────────

  for (const { pattern, label, weight } of OPINION_PATTERNS) {
    if (pattern.test(text)) {
      opinionScore += weight;
      reasons.push(`opinion:${label}`);
    }
  }

  // ── Determine type (institutional_static takes precedence) ────────

  if (staticScore >= STATIC_SCORE_THRESHOLD) {
    return {
      content_type: 'institutional_static',
      score: Math.min(staticScore, 1.0),
      reasons,
    };
  }

  if (institutionalScore >= INSTITUTIONAL_SCORE_THRESHOLD) {
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
  const maxScore = Math.max(institutionalScore, opinionScore, staticScore);
  if (maxScore === 0 && reasons.length === 0) {
    return { content_type: 'news', score: 0, reasons: [] };
  }

  return {
    content_type: 'news',
    score: maxScore,
    reasons,
  };
}
