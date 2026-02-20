/**
 * Pair-scoring for Linking v2.1 — two-step linking with hard negative gates.
 *
 * Composite score = 0.55*embedding + 0.25*entity + 0.20*temporal
 *
 * Hard blocks (always force CREATE, even if score is high):
 *   - action_incompatible: article action conflicts with event action
 *   - city_mismatch: article city != event city (when both have high confidence)
 *   - date_gap: event fact dates differ by >7 days
 *
 * v2.1 additions:
 *   - Hard negative gates (entity, topic, title) block auto-link → degrade to maybe
 *   - Two-step: auto-link requires N strong signals (embedding, entity, topic)
 *   - Enhanced entity guard with 2 thresholds (auto vs maybe)
 *
 * LLM response shape (when used):
 *   { same_event: 0..1, hard_block: boolean, reason_codes: string[] }
 *   hard_block from LLM is ALWAYS respected.
 */

import { cosineSimilarity, computeCentroid } from './similarity.js';
import { LlmClient } from '../../../core/llm/client.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import {
  shouldBlockAutoLink,
  checkTitleContradictionPair,
  GateContext,
} from './hard-negative-gates.js';
import {
  HARD_NEGATIVE_ENABLED,
  TWO_STEP_ENABLED,
  AUTO_MIN_ENTITY_JACCARD,
  MAYBE_MIN_ENTITY_JACCARD,
  AUTO_REQUIRES_SIGNALS,
  SIGNAL_MIN_EMBED,
  SIGNAL_MIN_ENTITY,
  SIGNAL_MIN_TOPIC,
  TITLE_GATE_ENABLED,
} from './config.js';

export const THETA_AUTO_LINK = parseFloat(process.env.THETA_AUTO_LINK ?? '0.45');
export const THETA_MAYBE_LINK = parseFloat(process.env.THETA_MAYBE_LINK ?? '0.30');
const DATE_GAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Kill switch: never auto-link, only maybe/create
export const DISABLE_AUTO_LINK = process.env.DISABLE_AUTO_LINK === '1';

// Legacy entity guard (kept for backward compat, now superseded by v2.1 gates)
export const ENTITY_GUARD_ENABLED = process.env.EVENT_LINKER_ENTITY_GUARD_ENABLED !== '0';
export const ENTITY_GUARD_MIN_JACCARD = parseFloat(process.env.EVENT_LINKER_ENTITY_GUARD_MIN_JACCARD ?? '0.01');

// ── Weights for composite score ──
const W_EMBEDDING = 0.55;
const W_ENTITY = 0.25;
const W_TEMPORAL = 0.20;

// ── Temporal decay: 3 days half-life ──
const TEMPORAL_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

export interface CandidateScore {
  eventId: string;
  embeddingSim: number;
  entityOverlap: number;
  temporalProximity: number;
  compositeScore: number;
  hardBlock: boolean;
  hardBlockReasons: string[];
  /** v2.1: reasons from hard negative gates that block auto-link */
  gatesBlockAutoReasons: string[];
  /** v2.1: which strong signals passed */
  signalsPassed: { embed: boolean; entity: boolean; topic: boolean; count: number };
  /** v2.1: final action for this candidate */
  finalAction: 'AUTO_LINK' | 'MAYBE_LINK' | 'CREATE';
}

export interface PairScoringResult {
  bestMatch: { eventId: string; score: number } | null;
  scores: CandidateScore[];
  action: 'LINK' | 'CREATE';
  /** v2.1: specific link type */
  linkType: 'AUTO_LINK' | 'MAYBE_LINK' | 'CREATE';
  llmUsed: boolean;
}

// ── Hard block input ──
export interface HardBlockContext {
  articleAction?: string | null;
  articleCity?: string | null;
  articleCityConfidence?: number;
  articleFactDate?: Date | null;
}

export interface EventCandidateContext {
  eventAction?: string | null;
  eventCity?: string | null;
  eventCityConfidence?: number;
  eventFactDateEarliest?: Date | null;
  eventFactDateLatest?: Date | null;
}

/**
 * Check hard block conditions between article and event.
 */
export function checkHardBlock(
  article: HardBlockContext,
  event: EventCandidateContext,
): { blocked: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // 1. Action incompatible
  if (
    article.articleAction && event.eventAction
    && article.articleAction !== event.eventAction
  ) {
    reasons.push('action_incompatible');
  }

  // 2. City mismatch (both high confidence)
  const CITY_CONFIDENCE_THRESHOLD = 0.7;
  if (
    article.articleCity && event.eventCity
    && article.articleCity.toLowerCase() !== event.eventCity.toLowerCase()
    && (article.articleCityConfidence ?? 0) >= CITY_CONFIDENCE_THRESHOLD
    && (event.eventCityConfidence ?? 0) >= CITY_CONFIDENCE_THRESHOLD
  ) {
    reasons.push('city_mismatch');
  }

  // 3. Date gap > 7 days
  if (article.articleFactDate && (event.eventFactDateEarliest || event.eventFactDateLatest)) {
    const artDateMs = article.articleFactDate.getTime();
    const earliest = event.eventFactDateEarliest?.getTime() ?? artDateMs;
    const latest = event.eventFactDateLatest?.getTime() ?? earliest;

    let gap = 0;
    if (artDateMs < earliest) {
      gap = earliest - artDateMs;
    } else if (artDateMs > latest) {
      gap = artDateMs - latest;
    }
    if (gap > DATE_GAP_MS) {
      reasons.push('date_gap');
    }
  }

  return { blocked: reasons.length > 0, reasons };
}

/**
 * Extract simple named entities from text.
 */
export function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  const capitalized = text.match(/[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+(?:\s+(?:(?:de|del|la|el|los|las|y|en)\s+)*[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+)*/g);
  if (capitalized) {
    for (const match of capitalized) {
      entities.add(match.toLowerCase().trim());
    }
  }
  const quoted = text.match(/"([^"]{3,50})"/g);
  if (quoted) {
    for (const match of quoted) {
      entities.add(match.replace(/"/g, '').toLowerCase().trim());
    }
  }
  return entities;
}

function entityOverlapScore(articleEntities: Set<string>, eventEntities: Set<string>): number {
  if (articleEntities.size === 0 || eventEntities.size === 0) return 0;
  let intersect = 0;
  for (const e of articleEntities) {
    if (eventEntities.has(e)) intersect++;
  }
  const union = new Set([...articleEntities, ...eventEntities]).size;
  return union > 0 ? intersect / union : 0;
}

function temporalProximity(articleTime: Date | null, eventT0: Date | null, eventTLast: Date | null): number {
  if (!articleTime) return 0.5;
  const artTs = articleTime.getTime();
  const t0 = eventT0?.getTime() ?? artTs;
  const tLast = eventTLast?.getTime() ?? t0;

  let distance: number;
  if (artTs >= t0 && artTs <= tLast) {
    distance = 0;
  } else if (artTs < t0) {
    distance = t0 - artTs;
  } else {
    distance = artTs - tLast;
  }

  return Math.exp(-0.693 * distance / TEMPORAL_HALF_LIFE_MS);
}

export interface ArticleForPairing {
  id: string;
  title: string;
  snippet: string;
  embeddingVec: number[];
  publishedAt: Date | null;
  hardBlockContext?: HardBlockContext;
  /** v2.1: topic assigned to this article (top1) */
  topicTop1?: string | null;
}

export interface EventCandidate {
  id: string;
  t0: Date | null;
  tLast: Date | null;
  articleVecs: number[][];
  articleTexts: string[];
  articleCount: number;
  uniqueMediaCount: number;
  hardBlockContext?: EventCandidateContext;
  /** v2.1: representative title for the event (first article's title) */
  representativeTitle?: string;
  /** v2.1: topic assigned to this event (top1) */
  topicTop1?: string | null;
}

/**
 * Count how many strong signals pass for a candidate.
 */
function countStrongSignals(
  embeddingSim: number,
  entityOverlap: number,
  topicSim: number | null,
): { embed: boolean; entity: boolean; topic: boolean; count: number } {
  const embed = embeddingSim >= SIGNAL_MIN_EMBED;
  const entity = entityOverlap >= SIGNAL_MIN_ENTITY;
  const topic = topicSim !== null ? topicSim >= SIGNAL_MIN_TOPIC : false;
  const count = (embed ? 1 : 0) + (entity ? 1 : 0) + (topic ? 1 : 0);
  return { embed, entity, topic, count };
}

/**
 * Score an article against a list of candidate events.
 * Includes hard block evaluation + v2.1 gate evaluation per candidate.
 */
export function scoreCandidates(
  article: ArticleForPairing,
  candidates: EventCandidate[],
): CandidateScore[] {
  const articleText = `${article.title} ${article.snippet}`;
  const articleEntities = extractEntities(articleText);

  const scores: CandidateScore[] = [];

  for (const candidate of candidates) {
    if (candidate.articleVecs.length === 0) continue;

    const centroid = computeCentroid(candidate.articleVecs);
    const embeddingSim = cosineSimilarity(article.embeddingVec, centroid);

    const eventText = candidate.articleTexts.join(' ');
    const eventEntities = extractEntities(eventText);
    const entOverlap = entityOverlapScore(articleEntities, eventEntities);

    const tempProx = temporalProximity(article.publishedAt, candidate.t0, candidate.tLast);

    const compositeScore =
      W_EMBEDDING * embeddingSim +
      W_ENTITY * entOverlap +
      W_TEMPORAL * tempProx;

    // Hard block check (original v2 hard blocks — force CREATE)
    const hardBlockCheck = checkHardBlock(
      article.hardBlockContext ?? {},
      candidate.hardBlockContext ?? {},
    );

    // v2.1: Hard negative gates (block auto-link only, not maybe)
    const gateReasons: string[] = [];
    let gateMaybeBlock = false;

    if (HARD_NEGATIVE_ENABLED && !hardBlockCheck.blocked) {
      // Entity gate (v2.1 enhanced 2-threshold)
      if (entOverlap < AUTO_MIN_ENTITY_JACCARD) {
        gateReasons.push('ENTITY_LOW_FOR_AUTO');
      }
      if (entOverlap < MAYBE_MIN_ENTITY_JACCARD && embeddingSim < 0.60) {
        gateReasons.push('ENTITY_VERY_LOW');
        gateMaybeBlock = true;
      }

      // Topic gate (top1 equality)
      if (article.topicTop1 && candidate.topicTop1) {
        if (article.topicTop1 !== candidate.topicTop1) {
          gateReasons.push('TOPIC_MISMATCH');
        }
      }

      // Title contradiction gate
      if (TITLE_GATE_ENABLED) {
        const eventRepTitle = candidate.representativeTitle ?? candidate.articleTexts[0] ?? '';
        const titleCheck = checkTitleContradictionPair(
          article.title,
          eventRepTitle,
          article.title,   // raw title
          eventRepTitle,
          embeddingSim,
          entOverlap,
        );
        if (titleCheck.blocked) {
          gateReasons.push('TITLE_CONTRADICTION_LOW_OVERLAP');
        }
      }
    }

    // v2.1: Compute signal strength
    const topicSim = (article.topicTop1 && candidate.topicTop1 && article.topicTop1 === candidate.topicTop1) ? 1.0 : null;
    const signals = countStrongSignals(embeddingSim, entOverlap, topicSim);

    // Determine finalAction per candidate
    let finalAction: 'AUTO_LINK' | 'MAYBE_LINK' | 'CREATE' = 'CREATE';
    if (hardBlockCheck.blocked) {
      finalAction = 'CREATE';
    } else if (compositeScore >= THETA_AUTO_LINK) {
      if (DISABLE_AUTO_LINK) {
        finalAction = 'MAYBE_LINK';
      } else if (gateReasons.length > 0) {
        finalAction = gateMaybeBlock ? 'CREATE' : 'MAYBE_LINK';
      } else if (TWO_STEP_ENABLED && signals.count < AUTO_REQUIRES_SIGNALS) {
        finalAction = 'MAYBE_LINK';
      } else {
        finalAction = 'AUTO_LINK';
      }
    } else if (compositeScore >= THETA_MAYBE_LINK) {
      finalAction = gateMaybeBlock ? 'CREATE' : 'MAYBE_LINK';
    }

    scores.push({
      eventId: candidate.id,
      embeddingSim,
      entityOverlap: entOverlap,
      temporalProximity: tempProx,
      compositeScore,
      hardBlock: hardBlockCheck.blocked,
      hardBlockReasons: hardBlockCheck.reasons,
      gatesBlockAutoReasons: gateReasons,
      signalsPassed: signals,
      finalAction,
    });
  }

  scores.sort((a, b) => b.compositeScore - a.compositeScore);
  return scores;
}

/**
 * Decide whether to link or create, using two-step scoring + hard negative gates + optional LLM.
 *
 * v2.1 Decision rules:
 *   1. DISABLE_AUTO_LINK=1 → never auto-link
 *   2. Auto-link ONLY if: score >= THETA_AUTO_LINK + no hard blocks + no gate blocks + >= N strong signals
 *   3. Maybe-link: score >= THETA_MAYBE_LINK (or auto blocked by gate) — NO signal requirement
 *   4. Below threshold → CREATE
 */
export async function decideLinkAction(
  article: ArticleForPairing,
  candidates: EventCandidate[],
  llm: LlmClient | null,
): Promise<PairScoringResult> {
  const scores = scoreCandidates(article, candidates);

  if (scores.length === 0) {
    return { bestMatch: null, scores, action: 'CREATE', linkType: 'CREATE', llmUsed: false };
  }

  // Only consider non-hard-blocked candidates
  const eligible = scores.filter((s) => !s.hardBlock);

  if (eligible.length === 0) {
    metrics.incCounter('linking.hard_block_total');
    metrics.incCounter('linking.create_total');
    return { bestMatch: null, scores, action: 'CREATE', linkType: 'CREATE', llmUsed: false };
  }

  const top = eligible[0];
  const topCandidate = candidates.find((c) => c.id === top.eventId);

  // ── Step 1: Check for auto-link eligibility ──
  if (top.finalAction === 'AUTO_LINK') {
    metrics.incCounter('linking.auto_link_total');
    return {
      bestMatch: { eventId: top.eventId, score: top.compositeScore },
      scores,
      action: 'LINK',
      linkType: 'AUTO_LINK',
      llmUsed: false,
    };
  }

  // Track gate downgrades
  if (top.gatesBlockAutoReasons.length > 0 && top.compositeScore >= THETA_AUTO_LINK) {
    metrics.incCounter('linking.gate_downgrade_total');
    logger.info({
      article_id: article.id,
      event_id: top.eventId,
      gates: top.gatesBlockAutoReasons,
      composite: +top.compositeScore.toFixed(4),
      signals: top.signalsPassed,
    }, 'gate_blocked_auto_link');
  }

  // Legacy entity guard metric (backward compat)
  if (ENTITY_GUARD_ENABLED && top.compositeScore >= THETA_AUTO_LINK && top.entityOverlap < ENTITY_GUARD_MIN_JACCARD) {
    metrics.incCounter('linking.entity_guard_downgrade_total');
  }

  // Track two-step signal downgrades
  if (TWO_STEP_ENABLED && top.compositeScore >= THETA_AUTO_LINK && top.gatesBlockAutoReasons.length === 0 && top.signalsPassed.count < AUTO_REQUIRES_SIGNALS) {
    metrics.incCounter('linking.two_step_downgrade_total');
    logger.info({
      article_id: article.id,
      event_id: top.eventId,
      signals: top.signalsPassed,
      required: AUTO_REQUIRES_SIGNALS,
    }, 'two_step_signal_insufficient');
  }

  // ── Step 2: Maybe-link zone ──
  if (top.finalAction === 'MAYBE_LINK' || (top.compositeScore >= THETA_MAYBE_LINK && top.finalAction !== 'CREATE')) {
    // Try LLM first if available
    if (llm) {
      const top3 = eligible.slice(0, 3);
      const llmResult = await llmPairScore(article, candidates, top3, llm);
      if (llmResult) {
        if (llmResult.hardBlock) {
          metrics.incCounter('linking.llm_hard_block_total');
          metrics.incCounter('linking.create_total');
          return { bestMatch: null, scores, action: 'CREATE', linkType: 'CREATE', llmUsed: true };
        }
        metrics.incCounter('linking.llm_link_total');
        return {
          bestMatch: { eventId: llmResult.eventId, score: llmResult.score },
          scores,
          action: 'LINK',
          linkType: 'MAYBE_LINK',
          llmUsed: true,
        };
      }
    }

    // Heuristic fallback: link if event has >= 1 article
    const uniqueMedia = topCandidate?.uniqueMediaCount ?? 0;
    if (uniqueMedia >= 1) {
      metrics.incCounter('linking.heuristic_link_total');
      return {
        bestMatch: { eventId: top.eventId, score: top.compositeScore },
        scores,
        action: 'LINK',
        linkType: 'MAYBE_LINK',
        llmUsed: false,
      };
    }
  }

  // Below threshold
  metrics.incCounter('linking.create_total');
  return { bestMatch: null, scores, action: 'CREATE', linkType: 'CREATE', llmUsed: false };
}

/**
 * LLM pair scoring — returns spec-exact response shape.
 */
async function llmPairScore(
  article: ArticleForPairing,
  candidates: EventCandidate[],
  top3: CandidateScore[],
  llm: LlmClient,
): Promise<{ eventId: string; score: number; hardBlock: boolean; reasonCodes: string[] } | null> {
  try {
    const candidateDescs = top3.map((s, i) => {
      const cand = candidates.find((c) => c.id === s.eventId);
      const sample = cand?.articleTexts.slice(0, 2).join(' | ') ?? '';
      return `Candidate ${i + 1} (${s.eventId}): score=${s.compositeScore.toFixed(3)}, sample="${sample.slice(0, 200)}"`;
    }).join('\n');

    const prompt = `You are an event-linking classifier for Colombian news. Determine if this article belongs to one of the candidate events.

Article: "${article.title}" — "${article.snippet.slice(0, 300)}"

Candidates:
${candidateDescs}

Respond with JSON: { "same_event": <0.0-1.0>, "hard_block": <true|false>, "reason_codes": [<strings>], "best_candidate_id": "<event_id or null>" }

Rules:
- same_event: confidence that article covers the same real-world event (0=different, 1=identical)
- hard_block: true if the article CANNOT belong to any candidate (different action, city, or dates differ >7d)
- reason_codes: e.g. ["action_incompatible"], ["city_mismatch"], ["date_gap"], or []
- best_candidate_id: the event_id of the best match, or null if no match`;

    const response = await llm.completeJson<{
      same_event: number;
      hard_block: boolean;
      reason_codes: string[];
      best_candidate_id: string | null;
    }>([{ role: 'user', content: prompt }]);

    const data = response.data;

    logger.info({
      article_id: article.id,
      same_event: data.same_event,
      hard_block: data.hard_block,
      reason_codes: data.reason_codes,
      best_candidate_id: data.best_candidate_id,
      latency_ms: response.meta.latency_ms,
    }, 'llm_pair_score_result');

    if (data.hard_block) {
      return {
        eventId: '',
        score: data.same_event,
        hardBlock: true,
        reasonCodes: data.reason_codes,
      };
    }

    if (data.best_candidate_id && data.same_event >= 0.6) {
      return {
        eventId: data.best_candidate_id,
        score: data.same_event,
        hardBlock: false,
        reasonCodes: data.reason_codes,
      };
    }

    return null;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'llm_pair_score_failed');
    metrics.incCounter('linking.llm_error_total');
    return null;
  }
}
