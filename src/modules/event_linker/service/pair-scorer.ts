/**
 * Pair-scoring for Linking v2.
 *
 * Given an article and a candidate event, produces a link score in [0, 1].
 * Two modes:
 *   1. Heuristic: embedding similarity + entity overlap + temporal proximity
 *   2. LLM-assisted: optional LLM call for borderline candidates (top 3)
 *
 * Thresholds:
 *   >= 0.62 → auto-link (high confidence)
 *   0.50–0.62 → link if LLM confirms (or heuristic fallback)
 *   < 0.50 → do not link
 */

import { cosineSimilarity, computeCentroid } from './similarity.js';
import { LlmClient } from '../../../core/llm/client.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';

export const THETA_AUTO_LINK = 0.62;
export const THETA_MAYBE_LINK = 0.50;

export interface CandidateScore {
  eventId: string;
  embeddingSim: number;
  entityOverlap: number;
  temporalProximity: number;
  compositeScore: number;
}

export interface PairScoringResult {
  bestMatch: { eventId: string; score: number } | null;
  scores: CandidateScore[];
  action: 'LINK' | 'CREATE';
  llmUsed: boolean;
}

// ── Weights for composite score ──
const W_EMBEDDING = 0.55;
const W_ENTITY = 0.25;
const W_TEMPORAL = 0.20;

// ── Temporal decay: 3 days half-life ──
const TEMPORAL_HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Extract simple named entities from text.
 * Heuristic: words starting with uppercase (after sentence start filtering),
 * multi-word proper nouns, and quoted terms.
 */
export function extractEntities(text: string): Set<string> {
  const entities = new Set<string>();
  // Match capitalized multi-word sequences (e.g., "Juan Manuel Santos", "Congreso de la República")
  const capitalized = text.match(/[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+(?:\s+(?:(?:de|del|la|el|los|las|y|en)\s+)*[A-ZÁÉÍÓÚÑÜ][a-záéíóúñü]+)*/g);
  if (capitalized) {
    for (const match of capitalized) {
      entities.add(match.toLowerCase().trim());
    }
  }
  // Also extract quoted terms
  const quoted = text.match(/"([^"]{3,50})"/g);
  if (quoted) {
    for (const match of quoted) {
      entities.add(match.replace(/"/g, '').toLowerCase().trim());
    }
  }
  return entities;
}

/**
 * Compute entity overlap ratio (Jaccard-like).
 */
function entityOverlap(articleEntities: Set<string>, eventEntities: Set<string>): number {
  if (articleEntities.size === 0 || eventEntities.size === 0) return 0;
  let intersect = 0;
  for (const e of articleEntities) {
    if (eventEntities.has(e)) intersect++;
  }
  const union = new Set([...articleEntities, ...eventEntities]).size;
  return union > 0 ? intersect / union : 0;
}

/**
 * Compute temporal proximity score based on how close the article is to the event's time window.
 */
function temporalProximity(articleTime: Date | null, eventT0: Date | null, eventTLast: Date | null): number {
  if (!articleTime) return 0.5; // unknown = neutral
  const artTs = articleTime.getTime();
  const t0 = eventT0?.getTime() ?? artTs;
  const tLast = eventTLast?.getTime() ?? t0;

  // Distance from the event's time window
  let distance: number;
  if (artTs >= t0 && artTs <= tLast) {
    distance = 0; // within window
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
}

export interface EventCandidate {
  id: string;
  t0: Date | null;
  tLast: Date | null;
  articleVecs: number[][];
  articleTexts: string[]; // title+snippet for entity extraction
  articleCount: number;
}

/**
 * Score an article against a list of candidate events.
 * Returns the best match and all scores.
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

    // Embedding similarity
    const centroid = computeCentroid(candidate.articleVecs);
    const embeddingSim = cosineSimilarity(article.embeddingVec, centroid);

    // Entity overlap
    const eventText = candidate.articleTexts.join(' ');
    const eventEntities = extractEntities(eventText);
    const entOverlap = entityOverlap(articleEntities, eventEntities);

    // Temporal proximity
    const tempProx = temporalProximity(article.publishedAt, candidate.t0, candidate.tLast);

    // Composite score
    const compositeScore =
      W_EMBEDDING * embeddingSim +
      W_ENTITY * entOverlap +
      W_TEMPORAL * tempProx;

    scores.push({
      eventId: candidate.id,
      embeddingSim,
      entityOverlap: entOverlap,
      temporalProximity: tempProx,
      compositeScore,
    });
  }

  // Sort by composite score descending
  scores.sort((a, b) => b.compositeScore - a.compositeScore);

  return scores;
}

/**
 * Decide whether to link or create, using heuristic scores and optional LLM.
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

  const top = scores[0];

  // Auto-link if above high-confidence threshold
  if (top.compositeScore >= THETA_AUTO_LINK) {
    metrics.incCounter('linking.auto_link_total');
    return {
      bestMatch: { eventId: top.eventId, score: top.compositeScore },
      scores,
      action: 'LINK',
      llmUsed: false,
    };
  }

  // Borderline: try LLM for top 3 candidates
  if (top.compositeScore >= THETA_MAYBE_LINK && llm) {
    const top3 = scores.slice(0, 3);
    const llmResult = await llmPairScore(article, candidates, top3, llm);
    if (llmResult) {
      metrics.incCounter('linking.llm_link_total');
      return {
        bestMatch: { eventId: llmResult.eventId, score: llmResult.score },
        scores,
        action: 'LINK',
        llmUsed: true,
      };
    }
  }

  // Below threshold or LLM rejected
  if (top.compositeScore >= THETA_MAYBE_LINK && !llm) {
    // Heuristic fallback: link if entity overlap is meaningful
    if (top.entityOverlap >= 0.15) {
      metrics.incCounter('linking.heuristic_link_total');
      return {
        bestMatch: { eventId: top.eventId, score: top.compositeScore },
        scores,
        action: 'LINK',
        llmUsed: false,
      };
    }
  }

  metrics.incCounter('linking.create_total');
  return { bestMatch: null, scores, action: 'CREATE', llmUsed: false };
}

/**
 * LLM pair scoring for borderline candidates.
 */
async function llmPairScore(
  article: ArticleForPairing,
  candidates: EventCandidate[],
  top3: CandidateScore[],
  llm: LlmClient,
): Promise<{ eventId: string; score: number } | null> {
  try {
    const candidateDescs = top3.map((s, i) => {
      const cand = candidates.find((c) => c.id === s.eventId);
      const sample = cand?.articleTexts.slice(0, 2).join(' | ') ?? '';
      return `Candidate ${i + 1} (${s.eventId}): score=${s.compositeScore.toFixed(3)}, sample="${sample.slice(0, 200)}"`;
    }).join('\n');

    const prompt = `You are an event-linking classifier. Determine if this news article belongs to one of the candidate events.

Article: "${article.title}" — "${article.snippet.slice(0, 300)}"

Candidates:
${candidateDescs}

Respond with JSON: {"match": null} or {"match": {"event_id": "...", "confidence": 0.0-1.0}}
Only match if the article clearly reports on the SAME real-world event as the candidate.`;

    const response = await llm.completeJson<{
      match: { event_id: string; confidence: number } | null;
    }>([{ role: 'user', content: prompt }]);

    if (response.data.match && response.data.match.confidence >= 0.6) {
      logger.info({
        article_id: article.id,
        matched_event: response.data.match.event_id,
        confidence: response.data.match.confidence,
        latency_ms: response.meta.latency_ms,
      }, 'llm_pair_score_match');
      return {
        eventId: response.data.match.event_id,
        score: response.data.match.confidence,
      };
    }

    logger.info({ article_id: article.id }, 'llm_pair_score_no_match');
    return null;
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'llm_pair_score_failed');
    metrics.incCounter('linking.llm_error_total');
    return null;
  }
}
