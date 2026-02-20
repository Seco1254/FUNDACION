export function extractMeta(html: string, property: string): string | null {
  const regex = new RegExp(
    `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
    'i',
  );
  const match = html.match(regex);
  if (match) return decodeHtmlEntities(match[1]);

  const regex2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
    'i',
  );
  const match2 = html.match(regex2);
  if (match2) return decodeHtmlEntities(match2[1]);

  return null;
}

export function extractH1(html: string): string | null {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  return match ? stripHtml(match[1]).trim() : null;
}

export function extractLeadParagraph(html: string): string | null {
  const match = html.match(/<p[^>]*class="[^"]*lead[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
  if (match) return stripHtml(match[1]).trim();

  const paragraphs = html.match(/<p[^>]*>([\s\S]*?)<\/p>/gi);
  if (paragraphs) {
    for (const p of paragraphs) {
      const text = stripHtml(p.replace(/<\/?p[^>]*>/gi, '')).trim();
      if (text.length > 40) return text;
    }
  }
  return null;
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function isValidDate(d: Date | null): boolean {
  return d !== null && !isNaN(d.getTime());
}

const MAX_TEXT_NORM_CHARS = 50_000;

const BOILERPLATE_PATTERNS = [
  /suscr[íi]be(te)?/i,
  /inicia sesi[óo]n/i,
  /newsletter/i,
  /cookies/i,
  /también le puede interesar/i,
  /te puede interesar/i,
  /noticias relacionadas/i,
  /contenido relacionado/i,
  /recomendados para ti/i,
  /más noticias/i,
  /lee también/i,
  /comparte esta noticia/i,
  /síguenos en/i,
  /publicidad/i,
  /copyright\s+©/i,
  /todos los derechos reservados/i,
  /términos y condiciones/i,
  /pol[íi]tica de privacidad/i,
];

const NOISE_TAGS_RE = /<(?:header|footer|nav|aside|script|style|noscript|iframe|form|button|svg|figure|figcaption)[^>]*>[\s\S]*?<\/(?:header|footer|nav|aside|script|style|noscript|iframe|form|button|svg|figure|figcaption)>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;

/**
 * Extract the full article body text from an HTML page.
 * Strategy:
 *   1. Try <article> tag content
 *   2. Fallback to <main> tag content
 *   3. Final fallback: all <p> tags in <body>
 * Then strip noise tags, boilerplate, and normalize whitespace.
 */
export function extractArticleBody(html: string): string {
  // Remove comments and noise tags first
  let cleaned = html.replace(COMMENT_RE, '');
  cleaned = cleaned.replace(NOISE_TAGS_RE, '');

  // Try <article> first, then <main>, then <body>
  let bodyHtml = '';
  const articleMatch = cleaned.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    bodyHtml = articleMatch[1];
  } else {
    const mainMatch = cleaned.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
    if (mainMatch) {
      bodyHtml = mainMatch[1];
    } else {
      bodyHtml = cleaned;
    }
  }

  // Extract text from <p> tags (paragraph-focused extraction)
  const paragraphs: string[] = [];
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  let pMatch;
  while ((pMatch = pRegex.exec(bodyHtml)) !== null) {
    const text = stripHtml(pMatch[1]).trim();
    if (text.length < 30) continue;
    if (BOILERPLATE_PATTERNS.some((pat) => pat.test(text))) continue;
    paragraphs.push(text);
  }

  // Deduplicate consecutive identical paragraphs
  const deduped: string[] = [];
  for (const p of paragraphs) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== p) {
      deduped.push(p);
    }
  }

  const fullText = deduped.join('\n\n');

  // Collapse excessive whitespace and truncate
  const normalized = fullText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return normalized.slice(0, MAX_TEXT_NORM_CHARS);
}
