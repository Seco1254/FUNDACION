/**
 * Hard Negative Gates v2.2 — cheap heuristics that block auto-link.
 *
 * Gates only block auto-link (degrade to maybe-link), never block maybe-link
 * (to avoid "mil eventos" explosion). Exception: entity gate can block maybe
 * when entityJaccard is extremely low AND embedding is not high.
 *
 * v2.2 additions:
 *   - Desk mismatch gate: URL-based desk/section extraction + compatibility matrix
 *   - Topic confidence gate: block if topics differ AND both have confidence >= threshold
 *   - Title gate thresholds tightened: title_jaccard < 0.03 AND entity_overlap < 0.02
 */

import { logger } from '../../../core/logging/logger.js';
import {
  HARD_NEGATIVE_ENABLED,
  AUTO_MIN_ENTITY_JACCARD,
  MAYBE_MIN_ENTITY_JACCARD,
  TOPIC_GATE_ENABLED,
  TOPIC_TOP1_MUST_MATCH,
  TITLE_GATE_ENABLED,
  TITLE_KEYWORD_JACCARD_MIN,
  TITLE_ENTITY_JACCARD_MIN,
  DESK_GATE_ENABLED,
  TOPIC_CONFIDENCE_MIN,
} from './config.js';

// ── Spanish stopwords (short list for title keyword extraction) ──
const ES_STOPWORDS = new Set([
  'para', 'como', 'pero', 'más', 'este', 'esta', 'esto', 'esos', 'esas',
  'aquí', 'allí', 'cual', 'donde', 'cuando', 'quien', 'cada', 'todo',
  'toda', 'todos', 'todas', 'otro', 'otra', 'otros', 'otras', 'mismo',
  'misma', 'sobre', 'entre', 'desde', 'hasta', 'según', 'durante',
  'contra', 'ante', 'tras', 'bajo', 'hacia', 'mediante', 'sino',
  'también', 'además', 'aunque', 'porque', 'pues', 'mientras',
  'después', 'antes', 'luego', 'solo', 'sólo', 'algo', 'nada',
  'mucho', 'poco', 'bien', 'mejor', 'peor', 'gran', 'gran',
  'tiene', 'tiene', 'hace', 'dice', 'está', 'están', 'será',
  'sido', 'hecho', 'puede', 'dijo', 'hay', 'fue', 'ser', 'son',
  'con', 'del', 'los', 'las', 'una', 'uno', 'unos', 'unas',
  'por', 'que', 'más', 'sus', 'les',
]);

// ── Desk extraction from URL path ────────────────────────────────

const DESK_SEGMENT_MAP: Record<string, string> = {
  'politica': 'POLITICA',
  'gobierno': 'POLITICA',
  'economia': 'ECONOMIA',
  'finanzas': 'ECONOMIA',
  'negocios': 'ECONOMIA',
  'deportes': 'DEPORTES',
  'deporte': 'DEPORTES',
  'futbol': 'DEPORTES',
  'salud': 'SALUD',
  'vida': 'SALUD',
  'seguridad': 'CRIMEN',
  'justicia': 'CRIMEN',
  'judicial': 'CRIMEN',
  'crimen': 'CRIMEN',
  'unidad-investigativa': 'CRIMEN',
  'bogota': 'BOGOTA',
  'colombia': 'COLOMBIA',
  'mundo': 'MUNDO',
  'internacional': 'MUNDO',
  'medio-ambiente': 'MEDIO_AMBIENTE',
  'ambiente': 'MEDIO_AMBIENTE',
  'entretenimiento': 'ENTRETENIMIENTO',
  'cultura': 'ENTRETENIMIENTO',
  'gente': 'ENTRETENIMIENTO',
  'opinion': 'OPINION',
  'columnistas': 'OPINION',
  'tecnologia': 'TECNOLOGIA',
  'tech': 'TECNOLOGIA',
};

// ── razonpublica.com category path mappings ──
const RAZON_PUBLICA_CATEGORY_MAP: Record<string, string> = {
  'politica-y-gobierno': 'POLITICA',
  'economia-y-sociedad': 'ECONOMIA',
  'conflicto-drogas-y-paz': 'CRIMEN',
  'internacional': 'MUNDO',
  'medio-ambiente': 'MEDIO_AMBIENTE',
  'regiones': 'COLOMBIA',
  'educacion': 'SALUD',
};

// ── consonante.org slug keywords ──
const CONSONANTE_SLUG_KEYWORDS: Record<string, string[]> = {
  CRIMEN: ['asesinato', 'masacre', 'violencia', 'eln', 'disidencias', 'armado', 'conflicto', 'minas', 'desplazamiento', 'amenaza', 'ataque'],
  MEDIO_AMBIENTE: ['rio', 'agua', 'acueducto', 'contaminacion', 'mineria', 'deforestacion', 'ambiental', 'inundacion', 'sequia', 'biodiversidad'],
  POLITICA: ['gobierno', 'elecciones', 'alcalde', 'gobernador', 'congreso', 'consulta', 'voto'],
  ECONOMIA: ['empleo', 'trabajo', 'pobreza', 'produccion', 'cafe', 'campesino', 'cooperativa'],
  SALUD: ['hospital', 'salud', 'eps', 'medico', 'enfermedad', 'vacuna'],
};

export interface DeskResult {
  desk: string | null;
  desk_source: 'url_segment' | 'domain_rule' | 'none';
}

/**
 * Extract a "desk" label from a URL's path segments.
 * Returns null if no recognized segment is found.
 *
 * v2: domain-specific rules for razonpublica.com and consonante.org.
 * Normalizes URL: lowercase, strip querystring/hash, tolerate trailing slashes.
 */
export function extractDesk(url: string | null | undefined): string | null {
  return extractDeskDetailed(url).desk;
}

/**
 * Detailed desk extraction with source tracing.
 */
export function extractDeskDetailed(url: string | null | undefined): DeskResult {
  if (!url) return { desk: null, desk_source: 'none' };
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, '');
    const segments = path.split('/').filter(Boolean);

    // ── Domain-specific rules (priority) ──

    if (host === 'razonpublica.com') {
      // Category pages: /categoria/temas/politica-y-gobierno/
      if (segments[0] === 'categoria' && segments[1] === 'temas' && segments[2]) {
        const mapped = RAZON_PUBLICA_CATEGORY_MAP[segments[2]];
        if (mapped) return { desk: mapped, desk_source: 'domain_rule' };
      }
      // Default: razonpublica is opinion/analysis
      return { desk: 'OPINION', desk_source: 'domain_rule' };
    }

    if (host === 'consonante.org') {
      // Articles at /noticia/slug — scan slug tokens for topic hints
      if (segments[0] === 'noticia' && segments[1]) {
        const slugTokens = segments[1].split('-');
        for (const [desk, keywords] of Object.entries(CONSONANTE_SLUG_KEYWORDS)) {
          for (const kw of keywords) {
            if (slugTokens.includes(kw)) {
              return { desk, desk_source: 'domain_rule' };
            }
          }
        }
        // Default for consonante /noticia/: COLOMBIA (community journalism)
        return { desk: 'COLOMBIA', desk_source: 'domain_rule' };
      }
      // /cat/ pages — regional
      if (segments[0] === 'cat') {
        return { desk: 'COLOMBIA', desk_source: 'domain_rule' };
      }
      return { desk: null, desk_source: 'none' };
    }

    // ── Generic segment-based extraction ──
    for (const seg of segments) {
      const desk = DESK_SEGMENT_MAP[seg];
      if (desk) return { desk, desk_source: 'url_segment' };
    }
    return { desk: null, desk_source: 'none' };
  } catch {
    return { desk: null, desk_source: 'none' };
  }
}

// ── Desk compatibility matrix ──
// Desks within the same group are compatible; across groups they are NOT.
// null desk is compatible with everything (no signal).

const DESK_COMPAT_GROUPS: string[][] = [
  ['CRIMEN', 'BOGOTA', 'COLOMBIA'],
  ['POLITICA', 'ECONOMIA'],
  ['SALUD'],
  ['DEPORTES'],
  ['MEDIO_AMBIENTE'],
  ['ENTRETENIMIENTO'],
  ['OPINION'],
  ['TECNOLOGIA'],
  ['MUNDO'],
];

const DESK_GROUP_INDEX = new Map<string, number>();
for (let i = 0; i < DESK_COMPAT_GROUPS.length; i++) {
  for (const d of DESK_COMPAT_GROUPS[i]) {
    DESK_GROUP_INDEX.set(d, i);
  }
}

/**
 * Check if two desks are compatible.
 * null desk → always compatible (no signal).
 */
export function desksCompatible(deskA: string | null, deskB: string | null): boolean {
  if (deskA === null || deskB === null) return true;
  if (deskA === deskB) return true;
  const groupA = DESK_GROUP_INDEX.get(deskA);
  const groupB = DESK_GROUP_INDEX.get(deskB);
  if (groupA === undefined || groupB === undefined) return true;
  return groupA === groupB;
}

export interface GateContext {
  articleTitle: string;
  articleTitleRaw?: string;
  articleEmbeddingCosine: number;
  articleEntityJaccard: number;
  articleTopicTop1?: string | null;
  eventTopicTop1?: string | null;
  articleUrl?: string | null;
  eventUrl?: string | null;
  articleTopicConfidence?: number | null;
  eventTopicConfidence?: number | null;
}

export interface GateResult {
  blocked: boolean;
  reasons: string[];
  blockMaybe: boolean;
}

/**
 * Evaluate all hard-negative gates for a candidate pair.
 * Returns whether auto-link should be blocked and the reasons.
 */
export function shouldBlockAutoLink(ctx: GateContext): GateResult {
  if (!HARD_NEGATIVE_ENABLED) {
    return { blocked: false, reasons: [], blockMaybe: false };
  }

  const reasons: string[] = [];
  let blockMaybe = false;

  // 1) Enhanced entity overlap gate (2 thresholds)
  if (ctx.articleEntityJaccard < AUTO_MIN_ENTITY_JACCARD) {
    reasons.push('ENTITY_LOW_FOR_AUTO');
  }
  if (ctx.articleEntityJaccard < MAYBE_MIN_ENTITY_JACCARD && ctx.articleEmbeddingCosine < 0.60) {
    reasons.push('ENTITY_VERY_LOW');
    blockMaybe = true;
  }

  // 2) Topic mismatch gate (with confidence threshold)
  if (TOPIC_GATE_ENABLED && TOPIC_TOP1_MUST_MATCH) {
    if (ctx.articleTopicTop1 && ctx.eventTopicTop1) {
      if (ctx.articleTopicTop1 !== ctx.eventTopicTop1) {
        const artConf = ctx.articleTopicConfidence ?? 0;
        const evtConf = ctx.eventTopicConfidence ?? 0;
        if (artConf >= TOPIC_CONFIDENCE_MIN && evtConf >= TOPIC_CONFIDENCE_MIN) {
          reasons.push('TOPIC_MISMATCH_HIGH_CONF');
        } else {
          reasons.push('TOPIC_MISMATCH');
        }
      }
    } else if (!ctx.articleTopicTop1 || !ctx.eventTopicTop1) {
      logger.debug({ article_topic: ctx.articleTopicTop1, event_topic: ctx.eventTopicTop1 }, 'topic_gate_missing_topics');
    }
  }

  // 3) Desk mismatch gate (URL-based)
  if (DESK_GATE_ENABLED) {
    const articleDesk = extractDesk(ctx.articleUrl);
    const eventDesk = extractDesk(ctx.eventUrl);
    if (!desksCompatible(articleDesk, eventDesk)) {
      reasons.push('DESK_MISMATCH');
    }
  }

  // 4) Title contradiction gate
  if (TITLE_GATE_ENABLED) {
    const titleCheck = checkTitleContradiction(ctx);
    if (titleCheck.blocked) {
      reasons.push('TITLE_CONTRADICTION_LOW_OVERLAP');
    }
  }

  return { blocked: reasons.length > 0, reasons, blockMaybe };
}

// ── Title contradiction internals ──

export interface TitlePairContext {
  articleTitle: string;
  articleTitleRaw?: string;
  articleEmbeddingCosine: number;
  articleEntityJaccard: number;
}

interface TitleCheckResult {
  blocked: boolean;
  keywordJaccard: number;
  entityJaccard: number;
}

function checkTitleContradiction(ctx: TitlePairContext & { eventTopicTop1?: string | null; articleTopicTop1?: string | null }): TitleCheckResult {
  // We need both titles — article title is in ctx, event title will be set via eventTitle
  // In practice this is called with the article's title and the event's representative title
  // which is set in the GateContext. For the gate, we compare article keywords vs event keywords
  // embedded in the candidate context. But since we only have articleTitle in ctx,
  // the event title comparison happens at scoreCandidates level where we pass both.
  // Here we just return not-blocked since we don't have eventTitle.
  // The actual check is done in checkTitleContradictionPair below.
  return { blocked: false, keywordJaccard: 1, entityJaccard: 1 };
}

/**
 * Check title contradiction between two titles.
 * Exported for use in pair scoring where both titles are available.
 */
export function checkTitleContradictionPair(
  titleA: string,
  titleB: string,
  titleARaw: string | undefined,
  titleBRaw: string | undefined,
  embeddingCosine: number,
  entityJaccardFromScoring: number,
): TitleCheckResult {
  const kwA = extractTitleKeywords(titleA);
  const kwB = extractTitleKeywords(titleB);
  const keywordJac = jaccardSets(kwA, kwB);

  const entA = extractTitleEntities(titleARaw ?? titleA);
  const entB = extractTitleEntities(titleBRaw ?? titleB);
  const entityJac = jaccardSets(entA, entB);

  // Exception: high embedding + some entity overlap → don't block
  if (embeddingCosine >= 0.65 && entityJaccardFromScoring >= 0.03) {
    return { blocked: false, keywordJaccard: keywordJac, entityJaccard: entityJac };
  }

  const blocked = keywordJac < TITLE_KEYWORD_JACCARD_MIN && entityJac < TITLE_ENTITY_JACCARD_MIN;

  return { blocked, keywordJaccard: keywordJac, entityJaccard: entityJac };
}

/**
 * Extract keywords from a normalized title:
 * - alphabetic tokens length >= 4
 * - exclude Spanish stopwords
 */
export function extractTitleKeywords(title: string): Set<string> {
  const tokens = title.toLowerCase().split(/\s+/);
  const kws = new Set<string>();
  for (const t of tokens) {
    const clean = t.replace(/[^a-záéíóúñü]/g, '');
    if (clean.length >= 4 && !ES_STOPWORDS.has(clean)) {
      kws.add(clean);
    }
  }
  return kws;
}

/**
 * Extract "key entities" from a raw title:
 * - Capitalized tokens (heuristic for proper nouns)
 * - Acronyms (2+ uppercase letters)
 * - Numbers with units (millones, billones, US, COP)
 */
export function extractTitleEntities(rawTitle: string): Set<string> {
  const entities = new Set<string>();

  // Capitalized words (not at sentence start — skip first word)
  const words = rawTitle.split(/\s+/);
  for (let i = 1; i < words.length; i++) {
    const w = words[i].replace(/[,.:;!?"""()]/g, '');
    if (w.length >= 2 && /^[A-ZÁÉÍÓÚÑÜ]/.test(w) && !/^(El|La|Los|Las|Un|Una|Del|De|En|Con|Por|Al|Se|Su|Lo)$/.test(w)) {
      entities.add(w.toLowerCase());
    }
  }
  // First word if capitalized, long enough, and not a common article
  if (words.length > 0) {
    const first = words[0].replace(/[,.:;!?"""()]/g, '');
    if (first.length >= 2 && /^[A-ZÁÉÍÓÚÑÜ]/.test(first) && !/^(El|La|Los|Las|Un|Una|Del|De|En|Con|Por|Al|Se|Su|Lo)$/.test(first)) {
      entities.add(first.toLowerCase());
    }
  }

  // Acronyms (2+ consecutive uppercase)
  const acronyms = rawTitle.match(/\b[A-ZÁÉÍÓÚÑÜ]{2,}\b/g);
  if (acronyms) {
    for (const a of acronyms) {
      entities.add(a.toLowerCase());
    }
  }

  // Numbers with units
  const numUnits = rawTitle.match(/\d[\d.,]*\s*(?:millones|billones|mil|US|COP|USD|EUR|%)/gi);
  if (numUnits) {
    for (const n of numUnits) {
      entities.add(n.toLowerCase().trim());
    }
  }

  return entities;
}

/**
 * Jaccard similarity between two sets.
 */
export function jaccardSets(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const item of a) {
    if (b.has(item)) intersect++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersect / union : 0;
}
