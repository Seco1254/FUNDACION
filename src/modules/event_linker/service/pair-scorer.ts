/**
 * Pair-scoring for Linking v2 — spec-exact implementation.
 *
 * Composite score = 0.55*embedding + 0.25*entity + 0.20*temporal
 *
 * Hard blocks (always force CREATE, even if score is high):
 *   - action_incompatible: article action conflicts with event action
 *   - city_mismatch: article city != event city (when both have high confidence)
 *   - date_gap: event fact dates differ by >7 days
 *
 * Merge decision:
 *   >= 0.62 AND no hard_block → assign (auto-link)
 *   0.50–0.62 → only assign if event has >= 2 unique media
 *   < 0.50 → create new event
 *
 * LLM response shape (when used):
 *   { same_event: 0..1, hard_block: boolean, reason_codes: string[] }
 *   hard_block from LLM is ALWAYS respected.
 */

import { cosineSimilarity, computeCentroid } from './similarity.js';
import { LlmClient } from '../../../core/llm/client.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';

export const THETA_AUTO_LINK = 0.62;
export const THETA_MAYBE_LINK = 0.50;
const DATE_GAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

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
}

export interface PairScoringResult {
  bestMatch: { eventId: string; score: number } | null;
  scores: CandidateScore[];
  action: 'LINK' | 'CREATE';
  llmUsed: boolean;
}

// ── Hard block input ──
export interface HardBlockContext {
  /** Action/category of the article (e.g., 'protest', 'election', 'accident') */
  articleAction?: string | null;
  /** City mentioned in the article */
  articleCity?: string | null;
  /** Confidence of city extraction (0-1) */
  articleCityConfidence?: number;
  /** Date of the fact described in the article */
  articleFactDate?: Date | null;
}

export interface EventCandidateContext {
  /** Dominant action/category of the event */
  eventAction?: string | null;
  /** Dominant city of the event */
  eventCity?: string | null;
  /** Confidence of city extraction (0-1) */
  eventCityConfidence?: number;
  /** Earliest fact date across event articles */
  eventFactDateEarliest?: Date | null;
  /** Latest fact date across event articles */
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

    // Check if article date is more than 7 days from the event's date range
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
}

/**
 * Score an article against a list of candidate events.
 * Includes hard block evaluation per candidate.
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

    // Hard block check
    const hardBlockCheck = checkHardBlock(
      article.hardBlockContext ?? {},
      candidate.hardBlockContext ?? {},
    );

    scores.push({
      eventId: candidate.id,
      embeddingSim,
      entityOverlap: entOverlap,
      temporalProximity: tempProx,
      compositeScore,
      hardBlock: hardBlockCheck.blocked,
      hardBlockReasons: hardBlockCheck.reasons,
    });
  }

  scores.sort((a, b) => b.compositeScore - a.compositeScore);
  return scores;
}

/**
 * Decide whether to link or create, using heuristic scores and optional LLM.
 *
 * Decision rules:
 *   >= 0.62 AND no hard_block → LINK
 *   0.50–0.62 AND no hard_block AND event has >= 2 unique media → LINK
 *   otherwise → CREATE
 */
export async function decideLinkAction(
  article: ArticleForPairing,
  candidates: EventCandidate[],
  llm: LlmClient | null,
): Promise<PairScoringResult> {
  const scores = scoreCandidates(article, candidates);

  if (scores.length === 0) {
    return { bestMatch: null, scores, action: 'CREATE', llmUsed: false };
  }

  // Only consider non-hard-blocked candidates
  const eligible = scores.filter((s) => !s.hardBlock);

  if (eligible.length === 0) {
    metrics.incCounter('linking.hard_block_total');
    metrics.incCounter('linking.create_total');
    return { bestMatch: null, scores, action: 'CREATE', llmUsed: false };
  }

  const top = eligible[0];
  const topCandidate = candidates.find((c) => c.id === top.eventId);

  // >= 0.62 → auto-link
  if (top.compositeScore >= THETA_AUTO_LINK) {
    metrics.incCounter('linking.auto_link_total');
    return {
      bestMatch: { eventId: top.eventId, score: top.compositeScore },
      scores,
      action: 'LINK',
      llmUsed: false,
    };
  }

  // 0.50–0.62 range
  if (top.compositeScore >= THETA_MAYBE_LINK) {
    // Try LLM first if available
    if (llm) {
      const top3 = eligible.slice(0, 3);
      const llmResult = await llmPairScore(article, candidates, top3, llm);
      if (llmResult) {
        if (llmResult.hardBlock) {
          // LLM says hard_block → always respect
          metrics.incCounter('linking.llm_hard_block_total');
          metrics.incCounter('linking.create_total');
          return { bestMatch: null, scores, action: 'CREATE', llmUsed: true };
        }
        metrics.incCounter('linking.llm_link_total');
        return {
          bestMatch: { eventId: llmResult.eventId, score: llmResult.score },
          scores,
          action: 'LINK',
          llmUsed: true,
        };
      }
    }

    // Heuristic fallback: only link if event has >= 2 unique media
    const uniqueMedia = topCandidate?.uniqueMediaCount ?? 0;
    if (uniqueMedia >= 2) {
      metrics.incCounter('linking.heuristic_link_total');
      return {
        bestMatch: { eventId: top.eventId, score: top.compositeScore },
        scores,
        action: 'LINK',
        llmUsed: false,
      };
    }
  }

  // Below threshold
  metrics.incCounter('linking.create_total');
  return { bestMatch: null, scores, action: 'CREATE', llmUsed: false };
}

/**
 * LLM pair scoring — returns spec-exact response shape.
 * LLM is asked for: { same_event: 0..1, hard_block: boolean, reason_codes: string[] }
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

    // Hard block from LLM is always respected
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
