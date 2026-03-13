/**
 * Non-news content classifier.
 *
 * Detects headlines that are clearly not news articles and should be
 * excluded from the For You feed: institutional pages, podcasts,
 * weekly digest indices, legal pages, "about us" pages, etc.
 *
 * Designed to be extensible — add patterns to the relevant array.
 * Returns a classification with reason for observability.
 */

export interface NonNewsResult {
  /** true = this is NOT a news article, should be excluded from feed */
  isNonNews: boolean;
  /** Which rule matched, for debug/observability */
  reason: string | null;
}

// ── Headline patterns that indicate non-news content ──

/**
 * Institutional page keywords (case-insensitive).
 * Matches the core phrase alone OR followed by a media-name separator
 * (e.g. " - Razón Pública", " | El Tiempo", " – FLIP").
 * The optional tail: zero or more spaces, a separator char, then anything.
 */
const MEDIA_SUFFIX = String.raw`(\s*[|\-–—:]\s*.*)?`;
const INSTITUTIONAL_EXACT: RegExp[] = [
  new RegExp(`^quiénes somos${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^nuestros servicios${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^contáctenos${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^cont[aá]ctanos${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^aviso legal${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^trabaja con nosotros${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^preguntas frecuentes${MEDIA_SUFFIX}$`, 'i'),
  new RegExp(`^mapa del sitio${MEDIA_SUFFIX}$`, 'i'),
];

/** Headline contains these patterns (substring match) */
const INSTITUTIONAL_CONTAINS: RegExp[] = [
  /pol[ií]tica de (protecci[oó]n|tratamiento|privacidad|datos|cookies)/i,
  /t[eé]rminos y condiciones/i,
  /aviso de privacidad/i,
  /derechos reservados/i,
  /condiciones de uso/i,
  /declaraci[oó]n de accesibilidad/i,
  /nuestros (servicios|principios|valores)/i,
];

/** Podcast / serial audio-content patterns */
const PODCAST_PATTERNS: RegExp[] = [
  // Existing: headline starts with podcast/pódcast
  /^p[oó]dcast\s*[|:–—]/i,
  /^podcast\b/i,
  // "Listen on Spotify/Apple/podcast" CTA
  /\b(escucha|escúchalo)\s+(en|aquí)\b.*\b(spotify|apple|podcast)\b/i,
  // Episode at start of headline: "Ep. 5 …", "Ep 12: …"
  /^ep\.?\s*\d+\b/i,
  // "Episodio 12" / "Episode 5" / "Capítulo 3" followed by separator (serial format)
  /\b(episodio|episode)\s+\d+\s*[|:–—.]/i,
  /\bcap[ií]tulo\s+\d+\s*[|:–—.]/i,
  // "T2E5", "T1 E3" — season+episode format (always serial)
  /\bT\d+\s*E\d+\b/i,
  // "Temporada 2" / "Season 3" followed by separator
  /\b(temporada|season)\s+\d+\s*[|:–—.]/i,
];

/** Weekly/daily digest indices (pattern: "edición del DD de MES al DD de MES") */
const DIGEST_PATTERNS: RegExp[] = [
  /^edici[oó]n del \d/i,
  /^resumen semanal/i,
  /^bolet[ií]n (semanal|diario|mensual)/i,
  /^lo m[aá]s (le[ií]do|visto|compartido) (de la semana|del mes|hoy)/i,
  /^en portada esta semana/i,
  /^\d+ noticias (para|del|de) (hoy|esta semana)/i,
];

/** Opinion/review/lifestyle that isn't hard news */
const SOFT_CONTENT_PATTERNS: RegExp[] = [
  /^neur[oó]tica an[oó]nima/i,
  /^hor[oó]scopo\b/i,
  /^crucigrama\b/i,
  /^sudoku\b/i,
  /^receta\s*:/i,
  /^rese[ñn]a\s*:/i,
];

/** Utility: test headline against a list of patterns */
function matchesAny(headline: string, patterns: RegExp[]): RegExp | null {
  for (const p of patterns) {
    if (p.test(headline)) return p;
  }
  return null;
}

/**
 * Classify whether a headline represents non-news content.
 *
 * Usage:
 *   const result = classifyNonNews(headline);
 *   if (result.isNonNews) { ... exclude from feed ... }
 */
export function classifyNonNews(headline: string): NonNewsResult {
  if (!headline || headline.trim().length === 0) {
    return { isNonNews: false, reason: null };
  }

  const h = headline.trim();

  // 1. Institutional exact-match
  const inst = matchesAny(h, INSTITUTIONAL_EXACT);
  if (inst) return { isNonNews: true, reason: 'institutional_exact' };

  // 2. Institutional substring
  const instSub = matchesAny(h, INSTITUTIONAL_CONTAINS);
  if (instSub) return { isNonNews: true, reason: 'institutional_contains' };

  // 3. Podcast
  const pod = matchesAny(h, PODCAST_PATTERNS);
  if (pod) return { isNonNews: true, reason: 'podcast' };

  // 4. Digest/index
  const dig = matchesAny(h, DIGEST_PATTERNS);
  if (dig) return { isNonNews: true, reason: 'digest_index' };

  // 5. Soft content
  const soft = matchesAny(h, SOFT_CONTENT_PATTERNS);
  if (soft) return { isNonNews: true, reason: 'soft_content' };

  // 6. ALL-CAPS headlines with no lowercase letters (often digest headers, index pages)
  // But only if short (< 80 chars) — long all-caps could be real breaking news
  if (h.length < 80 && h === h.toUpperCase() && /^[A-ZÁÉÍÓÚÑÜ\s|:–—,.\d]+$/.test(h)) {
    // Check if it looks like an index/edition header
    if (/\d/.test(h) && /(EDICI[ÓO]N|FEBRERO|MARZO|ENERO|ABRIL|MAYO|JUNIO|JULIO|AGOSTO|SEPTIEMBRE|OCTUBRE|NOVIEMBRE|DICIEMBRE)/i.test(h)) {
      return { isNonNews: true, reason: 'allcaps_date_header' };
    }
  }

  return { isNonNews: false, reason: null };
}
