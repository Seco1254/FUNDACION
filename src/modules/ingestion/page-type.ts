/**
 * Page-Type classifier — deterministic URL/title heuristics.
 *
 * Classifies a URL into one of:
 *   ARTICLE | AUTHOR_PAGE | COMMERCIAL_CONTENT | LISTING_INDEX | OTHER
 *
 * Used early in the ingestion pipeline to block non-article pages
 * before they pollute events and the feed.
 *
 * Zero dependencies on DB or network — pure function.
 */

export type PageType =
  | 'ARTICLE'
  | 'AUTHOR_PAGE'
  | 'COMMERCIAL_CONTENT'
  | 'LISTING_INDEX'
  | 'PODCAST'
  | 'OTHER';

export interface PageTypeInput {
  url: string;
  title?: string | null;
  html?: string | null;
  extractedText?: string | null;
  stats?: {
    linkCount?: number;
    textLength?: number;
    linkTextRatio?: number;
  };
  mediaKey?: string | null;
  /** Optional raw headline (e.g. from scraper) for podcast detection. */
  headline?: string | null;
}

export interface PageTypeResult {
  pageType: PageType;
  confidence: number;
  reasons: string[];
  flags: Record<string, boolean>;
}

// ── URL patterns ─────────────────────────────────────────────────

/** AUTHOR_PAGE: URL segments that indicate author/journalist profile pages. */
const AUTHOR_URL_PATTERNS: RegExp[] = [
  /\/autor\//i,
  /\/autores\//i,
  /\/columnista\//i,
  /\/periodista\//i,
];

/** COMMERCIAL_CONTENT: URL segments for sponsored/commercial content. */
const COMMERCIAL_URL_PATTERNS: RegExp[] = [
  /\/contenido-comercial\//i,
  /\/contenido-patrocinado\//i,
  /\/mas-contenido\//i,
  /\/publireportaje\//i,
  /\/branded-content\//i,
  /\/sponsored\//i,
];

/** PODCAST: URL segments for podcast / audio / video episode pages. */
const PODCAST_URL_PATTERNS: RegExp[] = [
  /\/podcast\//i,
  /\/podcasts\//i,
  /\/episodio\//i,
  /\/episodios\//i,
  /\/audio\//i,
  /\/video\//i,
];

/** PODCAST: title patterns for podcast/audio content. */
const PODCAST_TITLE_PATTERNS: RegExp[] = [
  /^P[OÓ]DCAST[\s:|-]/i,
  /^PODCAST[\s:|-]/i,
  /^\[P[OÓ]DCAST\]/i,
  /^Escuche[\s:]/i,
];

/** LISTING_INDEX: URL segments for tag, category, and search listings. */
const LISTING_URL_PATTERNS: RegExp[] = [
  /\/tag\//i,
  /\/tags\//i,
  /\/categoria\//i,
  /\/categorias\//i,
  /\/temas\//i,
  /\/tema\//i,
  /\/buscador\b/i,
  /\/buscar\b/i,
  /\/archivo\//i,
  /\/seccion\//i,
];

// ── Title patterns ───────────────────────────────────────────────

/** AUTHOR_PAGE: title patterns typical of author profile pages. */
const AUTHOR_TITLE_PATTERNS: RegExp[] = [
  /noticias,?\s+fotos\s+y\s+videos\s+de\b/i,
  /\bperfil\s+de\s+(periodista|columnista|autor)/i,
  /^autor(a)?:\s/i,
];

/** COMMERCIAL_CONTENT: title patterns for sponsored content. */
const COMMERCIAL_TITLE_PATTERNS: RegExp[] = [
  /\bcontenido\s+comercial\b/i,
  /\bcontenido\s+patrocinado\b/i,
  /\bpublireportaje\b/i,
];

/** LISTING_INDEX: title patterns for category/tag listing pages. */
const LISTING_TITLE_PATTERNS: RegExp[] = [
  /^(noticias|artículos|últimas noticias)\s+(sobre|de|en)\s+/i,
  /\búltimas\s+noticias\b/i,
  // TODO: "Resultados de búsqueda" → LISTING_INDEX
];

// ── Core classifier ──────────────────────────────────────────────

/**
 * Classify a page into a PageType based on URL and title heuristics.
 *
 * Priority order (first match wins):
 *  1. AUTHOR_PAGE        — URL or title match
 *  2. COMMERCIAL_CONTENT — URL or title match
 *  3. PODCAST            — URL or title/headline match
 *  4. LISTING_INDEX      — URL or title match
 *  5. ARTICLE            — default
 */
export function classifyPageType(input: PageTypeInput): PageTypeResult {
  const { url, title } = input;
  const reasons: string[] = [];
  const flags: Record<string, boolean> = {
    is_author: false,
    is_commercial: false,
    is_podcast: false,
    is_listing: false,
  };

  // Normalize URL path for matching
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname.toLowerCase();
  } catch {
    urlPath = url.toLowerCase();
  }

  const titleLower = (title ?? '').toLowerCase();

  // ── 1. AUTHOR_PAGE ──
  for (const pat of AUTHOR_URL_PATTERNS) {
    if (pat.test(urlPath)) {
      reasons.push(`URL_MATCH:${pat.source}`);
      flags.is_author = true;
    }
  }
  for (const pat of AUTHOR_TITLE_PATTERNS) {
    if (title && pat.test(title)) {
      reasons.push(`TITLE_MATCH:${pat.source}`);
      flags.is_author = true;
    }
  }

  if (flags.is_author) {
    return {
      pageType: 'AUTHOR_PAGE',
      confidence: reasons.length >= 2 ? 0.95 : 0.85,
      reasons,
      flags,
    };
  }

  // ── 2. COMMERCIAL_CONTENT ──
  for (const pat of COMMERCIAL_URL_PATTERNS) {
    if (pat.test(urlPath)) {
      reasons.push(`URL_MATCH:${pat.source}`);
      flags.is_commercial = true;
    }
  }
  for (const pat of COMMERCIAL_TITLE_PATTERNS) {
    if (title && pat.test(title)) {
      reasons.push(`TITLE_MATCH:${pat.source}`);
      flags.is_commercial = true;
    }
  }

  if (flags.is_commercial) {
    return {
      pageType: 'COMMERCIAL_CONTENT',
      confidence: reasons.length >= 2 ? 0.95 : 0.85,
      reasons,
      flags,
    };
  }

  // ── 3. PODCAST ──
  for (const pat of PODCAST_URL_PATTERNS) {
    if (pat.test(urlPath)) {
      reasons.push(`URL_MATCH:${pat.source}`);
      flags.is_podcast = true;
    }
  }
  // Check title and optional headline for podcast patterns
  const titlesToCheck = [title, input.headline].filter(Boolean) as string[];
  for (const pat of PODCAST_TITLE_PATTERNS) {
    for (const t of titlesToCheck) {
      if (pat.test(t)) {
        reasons.push(`TITLE_MATCH:${pat.source}`);
        flags.is_podcast = true;
      }
    }
  }

  if (flags.is_podcast) {
    return {
      pageType: 'PODCAST',
      confidence: reasons.length >= 2 ? 0.95 : 0.85,
      reasons,
      flags,
    };
  }

  // ── 4. LISTING_INDEX (renumbered) ──
  for (const pat of LISTING_URL_PATTERNS) {
    if (pat.test(urlPath)) {
      reasons.push(`URL_MATCH:${pat.source}`);
      flags.is_listing = true;
    }
  }
  for (const pat of LISTING_TITLE_PATTERNS) {
    if (title && pat.test(titleLower)) {
      reasons.push(`TITLE_MATCH:${pat.source}`);
      flags.is_listing = true;
    }
  }

  if (flags.is_listing) {
    return {
      pageType: 'LISTING_INDEX',
      confidence: reasons.length >= 2 ? 0.90 : 0.75,
      reasons,
      flags,
    };
  }

  // ── 5. Default: ARTICLE ──
  return {
    pageType: 'ARTICLE',
    confidence: 1.0,
    reasons: ['DEFAULT_ARTICLE'],
    flags,
  };
}

/**
 * Returns true if the page type should be blocked from the pipeline.
 * Only ARTICLE pages are allowed through.
 */
export function shouldBlockPageType(pageType: PageType): boolean {
  return pageType !== 'ARTICLE';
}
