/**
 * DOM Cleaner — HTML-level deterministic cleaning before text extraction.
 *
 * Removes boilerplate DOM nodes (nav, footer, ads, comments, sidebars,
 * related-articles, UGC, cookie banners, donation blocks, etc.) using
 * a real HTML parser (node-html-parser) instead of fragile regex.
 *
 * 0 LLM calls — pure heuristics only.
 */

import { parse, HTMLElement } from 'node-html-parser';
import { decodeHtmlEntities } from '../ingestion/scrapers/html-utils.js';

// ── Types ───────────────────────────────────────────────────────

export interface DomCleanerInput {
  html: string;
  url?: string;
}

export interface DomCleanerStats {
  nodes_removed: number;
  chars_before: number;
  chars_after: number;
  content_container: string; // 'article' | 'main' | 'heuristic' | 'fallback'
  ugc_cutoff_applied: boolean;
}

export interface DomCleanerResult {
  text: string;
  stats: DomCleanerStats;
}

// ── Config constants ────────────────────────────────────────────

/** Tags removed entirely (content + descendants). */
const STRIP_TAGS = new Set([
  'script', 'style', 'noscript', 'nav', 'footer', 'aside', 'form',
  'iframe', 'svg', 'button', 'select', 'input', 'textarea',
]);

/**
 * Class/ID regex — nodes whose class or id match are removed.
 * Case-insensitive. Covers: comments, social, related, newsletter,
 * subscription, cookies, modals, popups, promos, ads, banners,
 * paywall, CTA, donations, patronage, legal, NIT, terms, etc.
 */
const NOISE_CLASS_ID_RE = /(?:comment|disqus|share|social|related|recommend|newsletter|subscri|cookie|modal|popup|promo|ads?\b|banner|paywall|cta|donat|apoy|patreon|account|nit|legal|terms|policy|sidebar|widget|footer|header-menu|mega-menu|sticky-bar|toolbar|login|signup|registro|suscri)/i;

/**
 * UGC section markers. If found in text, everything from that point
 * onward is considered user-generated content and is cut.
 */
const UGC_MARKERS: RegExp[] = [
  /^Comentarios\s*$/m,
  /^Deja (?:tu )?comentario/im,
  /^Inicia sesión para comentar/im,
  /^Escribe (?:tu |un )?comentario/im,
  /^Deja (?:una )?respuesta/im,
  /^\d+ (?:comentarios?|respuestas?)/im,
  /^Comments?\s*$/im,
  /^Leave a (?:comment|reply)/im,
];

/** Max output text length (chars). */
const MAX_TEXT_LEN = 20_000;

/** Min text length to be considered usable for overview. */
export const DOM_CLEANER_MIN_USABLE_LEN = 600;

/** Min text length for cleaned output — below this we fall back to raw extraction. */
const MIN_CLEANED_LEN = 400;

// ── Helpers ─────────────────────────────────────────────────────

function hasNoiseClassOrId(node: HTMLElement): boolean {
  const cls = node.getAttribute('class') ?? '';
  const id = node.getAttribute('id') ?? '';
  return NOISE_CLASS_ID_RE.test(cls) || NOISE_CLASS_ID_RE.test(id);
}

/**
 * Heuristic content score for a node:
 *   score = text_length - 5 * link_count
 * Only considers nodes with some depth (not the root <html>/<body>).
 */
function contentScore(node: HTMLElement): number {
  const textLen = node.textContent.length;
  const linkCount = node.querySelectorAll('a').length;
  return textLen - 5 * linkCount;
}

/**
 * Decode common HTML entities + numeric references.
 */
function decodeEntities(text: string): string {
  // First use the existing decoder for named entities
  let decoded = decodeHtmlEntities(text);
  // Then handle numeric/hex references: &#187; &#x00BB;
  decoded = decoded.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(parseInt(code, 10)));
  decoded = decoded.replace(/&#x([0-9a-fA-F]+);/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)));
  return decoded;
}

/**
 * Extract clean text from an HTMLElement, preserving paragraph breaks.
 * Inserts double newlines between block-level elements.
 */
function extractText(root: HTMLElement): string {
  const blockTags = new Set([
    'p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li', 'blockquote', 'pre', 'tr', 'section', 'article',
  ]);

  const parts: string[] = [];

  for (const child of root.childNodes) {
    if (child.nodeType === 3) {
      // Text node
      const t = child.rawText.trim();
      if (t) parts.push(t);
    } else if (child instanceof HTMLElement) {
      const tag = child.tagName?.toLowerCase();
      const inner = extractText(child);
      if (!inner) continue;

      if (blockTags.has(tag)) {
        parts.push('\n\n' + inner + '\n\n');
      } else {
        parts.push(inner);
      }
    }
  }

  return parts.join(' ');
}

/**
 * Collapse whitespace: normalize runs, max 2 consecutive newlines.
 */
function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')           // horizontal whitespace → single space
    .replace(/ ?\n ?/g, '\n')          // trim around newlines
    .replace(/\n{3,}/g, '\n\n')        // max 2 consecutive newlines
    .trim();
}

/**
 * Remove lines that are exact duplicates of a previous line (boilerplate
 * that survived DOM cleaning, e.g., repeated "Compartir en Facebook").
 */
function stripRepeatedLines(text: string): string {
  const lines = text.split('\n');
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      result.push(line);
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }

  return result.join('\n');
}

// ── Main ────────────────────────────────────────────────────────

/**
 * Clean raw HTML and extract main article text.
 *
 * Strategy:
 *   1. Parse DOM, strip script/style/nav/footer/aside/form tags
 *   2. Remove nodes whose class/id matches noise patterns
 *   3. Select best content container: <article> → <main> → heuristic
 *   4. Extract text with paragraph breaks
 *   5. Apply UGC cutoff
 *   6. Decode entities, collapse whitespace, strip repeated lines
 *   7. Enforce max length cap
 *   8. If result too short (< MIN_CLEANED_LEN), fall back to raw text
 */
export function cleanDom(input: DomCleanerInput): DomCleanerResult {
  const { html } = input;
  const charsBefore = html.length;
  let nodesRemoved = 0;

  // ── 1. Parse ──────────────────────────────────────────────────
  const root = parse(html, {
    comment: false,   // strip HTML comments
    blockTextElements: { script: true, noscript: true, style: true },
  });

  // ── 2. Strip noise tags ───────────────────────────────────────
  for (const tag of STRIP_TAGS) {
    const nodes = root.querySelectorAll(tag);
    for (const n of nodes) {
      n.remove();
      nodesRemoved++;
    }
  }

  // ── 3. Strip nodes by class/id ────────────────────────────────
  // Walk all elements and remove matching ones.
  // We iterate in reverse to avoid index shifts.
  const allElements = root.querySelectorAll('*');
  for (let i = allElements.length - 1; i >= 0; i--) {
    const el = allElements[i];
    if (el instanceof HTMLElement && hasNoiseClassOrId(el)) {
      el.remove();
      nodesRemoved++;
    }
  }

  // ── 4. Select best content container ──────────────────────────
  let container: HTMLElement;
  let containerType: string;

  const articleEl = root.querySelector('article');
  const mainEl = root.querySelector('main');

  if (articleEl && articleEl.textContent.trim().length > MIN_CLEANED_LEN) {
    container = articleEl;
    containerType = 'article';
  } else if (mainEl && mainEl.textContent.trim().length > MIN_CLEANED_LEN) {
    container = mainEl;
    containerType = 'main';
  } else {
    // Heuristic: find the div/section with highest content score
    const candidates = root.querySelectorAll('div, section');
    let bestNode: HTMLElement | null = null;
    let bestScore = -Infinity;

    for (const c of candidates) {
      if (!(c instanceof HTMLElement)) continue;
      // Skip shallow containers (direct children of body/html)
      const score = contentScore(c);
      if (score > bestScore) {
        bestScore = score;
        bestNode = c;
      }
    }

    if (bestNode && bestNode.textContent.trim().length >= MIN_CLEANED_LEN) {
      container = bestNode;
      containerType = 'heuristic';
    } else {
      // Final fallback: use the entire document
      container = root;
      containerType = 'fallback';
    }
  }

  // ── 5. Extract text ───────────────────────────────────────────
  let text = extractText(container);

  // ── 6. UGC cutoff ────────────────────────────────────────────
  let ugcCutoff = false;
  for (const marker of UGC_MARKERS) {
    const match = marker.exec(text);
    if (match) {
      const cutPoint = match.index;
      // Only cut if we'd retain at least MIN_CLEANED_LEN chars
      if (cutPoint >= MIN_CLEANED_LEN) {
        text = text.slice(0, cutPoint);
        ugcCutoff = true;
        break;
      }
    }
  }

  // ── 7. Normalize ─────────────────────────────────────────────
  text = decodeEntities(text);
  text = normalizeWhitespace(text);
  text = stripRepeatedLines(text);

  // ── 8. Length cap ─────────────────────────────────────────────
  if (text.length > MAX_TEXT_LEN) {
    text = text.slice(0, MAX_TEXT_LEN);
  }

  // ── 9. Fallback check ────────────────────────────────────────
  // If cleaned text is too short, return empty to signal fallback
  if (text.length < MIN_CLEANED_LEN) {
    return {
      text: '',
      stats: {
        nodes_removed: nodesRemoved,
        chars_before: charsBefore,
        chars_after: 0,
        content_container: containerType,
        ugc_cutoff_applied: ugcCutoff,
      },
    };
  }

  return {
    text,
    stats: {
      nodes_removed: nodesRemoved,
      chars_before: charsBefore,
      chars_after: text.length,
      content_container: containerType,
      ugc_cutoff_applied: ugcCutoff,
    },
  };
}
