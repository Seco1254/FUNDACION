/**
 * Heuristic junk-score calculator for articles.
 *
 * Produces a score in [0, 1] where higher = more likely junk/ads.
 * Thresholds:
 *   >= 0.75  → exclude from feed
 *   0.45–0.75 → penalize in ranking (J factor)
 *   < 0.45  → normal
 */

export interface JunkSignals {
  url: string;
  title: string;
  snippet: string;
  authorOrSection?: string | null;
}

export interface JunkResult {
  score: number;
  signals: string[];
}

// ── URL patterns that indicate ad/promotional content ──
const JUNK_URL_PATTERNS = [
  /\/(patrocinado|sponsored|advertorial|publireportaje|promo)\b/i,
  /\/(clasificados|classifieds|avisos)\b/i,
  /\/(tienda|shop|store|comprar)\b/i,
  /\/(suscri[bp]|subscribe|membership|registro)\b/i,
  /utm_source=/i,
  /\/(landing|lp)\//i,
  /\/(oferta|deal|descuento|cupón|cupon)\b/i,
];

// ── Author/section names common in advertorials ──
const JUNK_AUTHOR_PATTERNS = [
  /\b(contenido\s+patrocinado|branded\s+content)\b/i,
  /\b(redacci[oó]n\s+comercial|comercial)\b/i,
  /\b(publirreportaje|advertorial)\b/i,
  /\b(patrocinado|sponsored)\b/i,
  /\b(aliado|partner|alianza)\b/i,
];

// ── Title keywords signaling ads/clickbait ──
const JUNK_TITLE_PATTERNS = [
  /\b(oferta|descuento|gratis|free|promo(ci[oó]n)?)\b/i,
  /\b(compra|comprar|adquiere|solicita|inscr[ií]bete)\b/i,
  /\b(patrocinado|sponsored|publirreportaje)\b/i,
  /\b(¡no\s+te\s+pierdas|imperdible|exclusiv[oa])\b/i,
  /\b(gana|sorte[oa]|concurso|rif[ao])\b/i,
  /\b(top\s+\d+|los\s+mejores\s+\d+|ranking\s+de)\b/i,
];

// ── SEO-spam patterns in title or snippet ──
const SEO_PATTERNS = [
  /\b(seo|keyword|backlink|link\s*building)\b/i,
  /\b(haz\s+clic|click\s+aqu[ií]|leer\s+m[aá]s|ver\s+m[aá]s)\b.*\b(haz\s+clic|click\s+aqu[ií]|leer\s+m[aá]s|ver\s+m[aá]s)\b/i,
  /(https?:\/\/\S+){3,}/i, // 3+ URLs in text = likely spam
];

// ── Feature weights ──
const W_URL = 0.35;
const W_AUTHOR = 0.45;
const W_TITLE = 0.30;
const W_SEO = 0.20;

export function computeJunkScore(input: JunkSignals): JunkResult {
  const signals: string[] = [];
  let raw = 0;

  // URL pattern check
  const urlHits = JUNK_URL_PATTERNS.filter((p) => p.test(input.url));
  if (urlHits.length > 0) {
    raw += W_URL;
    signals.push(`url_pattern(${urlHits.length})`);
  }

  // Author/section check
  if (input.authorOrSection) {
    const authorHits = JUNK_AUTHOR_PATTERNS.filter((p) => p.test(input.authorOrSection!));
    if (authorHits.length > 0) {
      raw += W_AUTHOR;
      signals.push(`author_section(${authorHits.length})`);
    }
  }

  // Title keyword check
  const titleHits = JUNK_TITLE_PATTERNS.filter((p) => p.test(input.title));
  if (titleHits.length > 0) {
    // Scale by number of hits: 1 match = half weight, 2+ = full weight
    const titleFactor = titleHits.length >= 2 ? 1.0 : 0.5;
    raw += W_TITLE * titleFactor;
    signals.push(`title_keywords(${titleHits.length})`);
  }

  // SEO spam in title+snippet
  const combined = `${input.title} ${input.snippet}`;
  const seoHits = SEO_PATTERNS.filter((p) => p.test(combined));
  if (seoHits.length > 0) {
    raw += W_SEO;
    signals.push(`seo_spam(${seoHits.length})`);
  }

  // Snippet too short for real article — mild signal
  if (input.snippet.length < 100) {
    raw += 0.10;
    signals.push('short_snippet');
  }

  // Clamp to [0, 1]
  const score = Math.min(1, Math.max(0, raw));

  return { score, signals };
}

// Threshold constants
export const JUNK_EXCLUDE_THRESHOLD = 0.75;
export const JUNK_PENALTY_THRESHOLD = 0.45;
