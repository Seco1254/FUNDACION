/**
 * Text sanitizer — deterministic, LLM-free text cleaning for Spanish news.
 *
 * Removes boilerplate, date/number noise, repeated sentences, navigation
 * fragments, and short lines before the text enters embeddings, key facts
 * extraction, or overview generation.
 */
import { logger } from '../../core/logging/logger.js';
import {
  TEXT_SANITIZER_ENABLED,
  DEBUG_TEXT_SANITIZER,
  TEXT_SANITIZER_NUMERIC_DENSITY_THRESHOLD,
  TEXT_SANITIZER_MAX_NOISE_LINE_LEN,
  TEXT_SANITIZER_DEDUP_ENABLED,
  TEXT_SANITIZER_DEDUP_JACCARD,
  TEXT_SANITIZER_MIN_ALPHA_CHARS,
} from './config.js';

// ── Types ───────────────────────────────────────────────────────

export type RemovalKind = 'boilerplate' | 'date_noise' | 'repeat_dedup' | 'short_line' | 'nav';

export interface Removal {
  kind: RemovalKind;
  sample: string;
}

export interface SanitizeStats {
  chars_before: number;
  chars_after: number;
  lines_before: number;
  lines_after: number;
  removed_lines: number;
}

export interface SanitizeResult {
  cleaned_text: string;
  removed: Removal[];
  stats: SanitizeStats;
  fingerprints?: { ngram_hashes_removed: number };
}

export interface SanitizeInput {
  text: string;
  lang?: 'es' | 'en';
  source?: { media_key?: string; url?: string };
}

// ── Boilerplate patterns (ES) ───────────────────────────────────

const BOILERPLATE_PATTERNS_ES: RegExp[] = [
  /\bsuscr[ií]b[ea](?:se|te)|suscripci[oó]n\b/i,
  /\bnewsletter\b/i,
  /\bbolet[ií]n(?:es)?\b/i,
  /\brecib[ea]\s+noticias\b/i,
  /\breg[ií]str[aeo](?:se|te)\b/i,
  /\binicia[r]?\s+sesi[oó]n\b/i,
  /\bcookies?\b/i,
  /\bt[eé]rminos\s+y\s+condiciones\b/i,
  /\bpol[ií]tica\s+de\s+privacidad\b/i,
  /\bconsentimiento\b/i,
  /\bpublicidad\b/i,
  /\banuncio\s+publicitario\b/i,
  /\bcontenido\s+patrocinado\b/i,
  /\bseguir\s+leyendo\b/i,
  /\bleer?\s+m[aá]s\b/i,
  /\bcompartir\s+en\s+(?:facebook|twitter|whatsapp|redes)\b/i,
  /\bs[ií]guenos\b/i,
  /\bredes\s+sociales\b/i,
  /\ben\s+nuestro\s+correo\b/i,
  /\bseg[uú]n\s+tus\s+intereses\b/i,
  /\baceptar?\s+cookies\b/i,
  /\bdescargar?\s+la\s+app\b/i,
  /\bnotificaciones\s+push\b/i,
  /\bcontenido\s+exclusivo\b/i,
  /\bapp\s+store|google\s+play\b/i,
  /\bderechos\s+reservados\b/i,
  /\bcerrar\s+(?:ventana|banner|aviso)\b/i,
  /\bcontenido\s+para\s+suscriptores\b/i,
  /\bte\s+puede\s+interesar\b/i,
  /\bnoticias\s+relacionadas\b/i,
  /\bm[aá]s\s+noticias\b/i,
  /\ble[ea]\s+tambi[eé]n\b/i,
];

const BOILERPLATE_PATTERNS_EN: RegExp[] = [
  /\bsubscribe\b/i,
  /\bnewsletter\b/i,
  /\bsign\s+up\b/i,
  /\blog\s+in\b/i,
  /\bcookies?\b/i,
  /\bterms\s+(?:of\s+service|and\s+conditions)\b/i,
  /\bprivacy\s+policy\b/i,
  /\badvertisement\b/i,
  /\bread\s+more\b/i,
  /\bshare\s+(?:on|this)\b/i,
  /\bfollow\s+us\b/i,
  /\bsocial\s+media\b/i,
  /\ball\s+rights\s+reserved\b/i,
];

// Block header patterns that indicate the next 1-3 lines are also boilerplate
const BLOCK_HEADER_PATTERNS: RegExp[] = [
  /^reg[ií]str[ae](?:se|te)/i,
  /^suscr[ií]b[ea](?:se|te)/i,
  /^m[aá]s\s+noticias/i,
  /^te\s+puede\s+interesar/i,
  /^noticias\s+relacionadas/i,
  /^le[ea]\s+tambi[eé]n/i,
  /^contenido\s+(?:exclusivo|patrocinado)/i,
  /^tags?\s*:/i,
  /^etiquetas?\s*:/i,
  /^compartir?\s*:/i,
];

// Navigation line patterns
const NAV_PATTERNS: RegExp[] = [
  /^(?:inicio|home)\s*[>›»|\/]/i,
  /^(?:portada|principal)\s*$/i,
  /^tags?\s*:/i,
  /^etiquetas?\s*:/i,
  /^categor[ií]a\s*:/i,
  /^men[uú]\s*$/i,
  /^secci[oó]n\s*:/i,
  /[>›»]\s*[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s*[>›»]/,
];

// ── Normalize helpers ───────────────────────────────────────────

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function countAlphaChars(line: string): number {
  return (line.match(/[\p{L}]/gu) ?? []).length;
}

function digitRatio(line: string): number {
  const alphaNum = line.replace(/[^\p{L}\p{N}]/gu, '');
  if (alphaNum.length === 0) return 0;
  const digits = (line.match(/\d/g) ?? []).length;
  return digits / alphaNum.length;
}

function alphaWordCount(line: string, minWordLen: number = 3): number {
  const words = line.split(/\s+/).filter(
    (w) => w.replace(/[^\p{L}]/gu, '').length >= minWordLen,
  );
  return words.length;
}

// ── N-gram shingle fingerprinting ───────────────────────────────

function normalizeForDedup(text: string): string {
  return stripAccents(text.toLowerCase()).replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
}

function wordShingles(text: string, n: number = 5): Set<string> {
  const words = text.split(' ');
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }
  // For short texts, use the full text as a single shingle
  if (shingles.size === 0 && words.length > 0) {
    shingles.add(words.join(' '));
  }
  return shingles;
}

function shingleJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersect = 0;
  for (const s of a) {
    if (b.has(s)) intersect++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersect / union : 0;
}

// ── Main sanitizer ──────────────────────────────────────────────

export function sanitizeText(input: SanitizeInput): SanitizeResult {
  const { text, lang = 'es', source } = input;

  // Pass-through if disabled
  if (!TEXT_SANITIZER_ENABLED) {
    return {
      cleaned_text: text,
      removed: [],
      stats: {
        chars_before: text.length,
        chars_after: text.length,
        lines_before: text.split('\n').length,
        lines_after: text.split('\n').length,
        removed_lines: 0,
      },
    };
  }

  const lines = text.split('\n');
  const removed: Removal[] = [];
  const kept: string[] = [];
  const boilerplatePatterns = lang === 'en' ? BOILERPLATE_PATTERNS_EN : BOILERPLATE_PATTERNS_ES;

  let skipNextLines = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines (just pass through)
    if (trimmed.length === 0) {
      kept.push(line);
      continue;
    }

    // If we're in a "block skip" zone from a header match
    if (skipNextLines > 0) {
      skipNextLines--;
      removed.push({ kind: 'boilerplate', sample: trimmed.slice(0, 80) });
      continue;
    }

    // ── 1. Block header check — skip this + next 2 lines ──
    // Only trigger for short standalone headers (≤50 chars), not full sentences
    const normalizedForMatch = stripAccents(trimmed.toLowerCase());
    let isBlockHeader = false;
    if (trimmed.length <= 50) {
      for (const pat of BLOCK_HEADER_PATTERNS) {
        if (pat.test(trimmed) || pat.test(normalizedForMatch)) {
          isBlockHeader = true;
          break;
        }
      }
    }
    if (isBlockHeader) {
      removed.push({ kind: 'boilerplate', sample: trimmed.slice(0, 80) });
      skipNextLines = 2;
      continue;
    }

    // ── 2. Boilerplate line check ──
    let isBoilerplate = false;
    for (const pat of boilerplatePatterns) {
      if (pat.test(trimmed) || pat.test(normalizedForMatch)) {
        isBoilerplate = true;
        break;
      }
    }
    if (isBoilerplate) {
      removed.push({ kind: 'boilerplate', sample: trimmed.slice(0, 80) });
      continue;
    }

    // ── 3. Navigation line check ──
    let isNav = false;
    for (const pat of NAV_PATTERNS) {
      if (pat.test(trimmed)) {
        isNav = true;
        break;
      }
    }
    if (isNav) {
      removed.push({ kind: 'nav', sample: trimmed.slice(0, 80) });
      continue;
    }

    // ── 4. Date/numeric noise ──
    if (
      trimmed.length <= TEXT_SANITIZER_MAX_NOISE_LINE_LEN &&
      digitRatio(trimmed) >= TEXT_SANITIZER_NUMERIC_DENSITY_THRESHOLD &&
      alphaWordCount(trimmed) < 2
    ) {
      removed.push({ kind: 'date_noise', sample: trimmed.slice(0, 80) });
      continue;
    }

    // ── 5. Short line hygiene ──
    if (countAlphaChars(trimmed) < TEXT_SANITIZER_MIN_ALPHA_CHARS && trimmed.length < 30) {
      removed.push({ kind: 'short_line', sample: trimmed.slice(0, 80) });
      continue;
    }

    kept.push(line);
  }

  // ── 6. Dedup pass (sentence-level) ──
  let ngramHashesRemoved = 0;
  let dedupedText: string;

  if (TEXT_SANITIZER_DEDUP_ENABLED) {
    const joinedKept = kept.join('\n');
    // Split into sentences (period/semicolon/colon boundary)
    const sentences = joinedKept.split(/(?<=[.;:])\s+/).filter((s) => s.trim().length > 0);

    const dedupedSentences: string[] = [];
    const seenFingerprints: Array<{ norm: string; shingles: Set<string> }> = [];

    for (const sentence of sentences) {
      const norm = normalizeForDedup(sentence);
      if (norm.length === 0) continue;

      const shingles = wordShingles(norm);
      let isDuplicate = false;

      for (const prev of seenFingerprints) {
        const sim = shingleJaccard(shingles, prev.shingles);
        if (sim >= TEXT_SANITIZER_DEDUP_JACCARD) {
          isDuplicate = true;
          break;
        }
      }

      if (isDuplicate) {
        ngramHashesRemoved++;
        removed.push({ kind: 'repeat_dedup', sample: sentence.trim().slice(0, 80) });
      } else {
        seenFingerprints.push({ norm, shingles });
        dedupedSentences.push(sentence);
      }
    }

    dedupedText = dedupedSentences.join(' ');
  } else {
    dedupedText = kept.join('\n');
  }

  const cleanedText = dedupedText.replace(/\n{3,}/g, '\n\n').trim();

  const stats: SanitizeStats = {
    chars_before: text.length,
    chars_after: cleanedText.length,
    lines_before: lines.length,
    lines_after: cleanedText.split('\n').length,
    removed_lines: removed.length,
  };

  // ── Debug logging ──
  if (DEBUG_TEXT_SANITIZER && removed.length > 0) {
    const removedByKind: Record<string, number> = {};
    for (const r of removed) {
      removedByKind[r.kind] = (removedByKind[r.kind] ?? 0) + 1;
    }
    logger.debug(
      {
        url: source?.url,
        media_key: source?.media_key,
        chars_before: stats.chars_before,
        chars_after: stats.chars_after,
        removed_counts_by_kind: removedByKind,
        sample_removed: removed.slice(0, 3).map((r) => `[${r.kind}] ${r.sample}`),
      },
      'text_sanitizer_applied',
    );
  }

  return {
    cleaned_text: cleanedText,
    removed,
    stats,
    fingerprints: { ngram_hashes_removed: ngramHashesRemoved },
  };
}
