/**
 * Hard Coherence Gate — deterministic heuristic checks that block incoherent
 * event clusters from reaching the overview generator and feed.
 *
 * No LLM calls. All checks use embeddings, entity extraction, and term overlap.
 */

import { cosineSimilarity, computeCentroid } from '../event_linker/service/similarity.js';
import {
  extractTitleKeywords,
  extractTitleEntities,
  jaccardSets,
} from '../event_linker/service/hard-negative-gates.js';
import { logger } from '../../core/logging/logger.js';

// ── Configuration (env-overridable) ─────────────────────────────────

export const COHERENCE_GATE_ENABLED = process.env.COHERENCE_GATE_ENABLED !== '0';

// Note: thresholds calibrated for hash256-v0.1 (non-neural) embeddings.
// Hash embeddings produce lower cosine similarities than neural models;
// THETA_MERGE in event_linker is 0.55 for reference.
export const THETA_EMBEDDING_COHESION = parseFloat(
  process.env.COHERENCE_EMBEDDING_COHESION_THRESHOLD ?? '0.55',
);

export const THETA_ENTITY_OVERLAP = parseFloat(
  process.env.COHERENCE_ENTITY_OVERLAP_THRESHOLD ?? '0.05',
);

export const THETA_TITLE_ALIGNMENT = parseFloat(
  process.env.COHERENCE_TITLE_ALIGNMENT_THRESHOLD ?? '0.10',
);

export const THETA_TOPIC_DRIFT = parseFloat(
  process.env.COHERENCE_TOPIC_DRIFT_THRESHOLD ?? '0.35',
);

export const MIN_FAILED_CHECKS_TO_BLOCK = parseInt(
  process.env.COHERENCE_MIN_FAILED_CHECKS ?? '2',
  10,
);

// ── Types ───────────────────────────────────────────────────────────

export interface ClusterArticle {
  id: string;
  title: string;
  titleRaw?: string;
  textNorm: string | null;
  embeddingVec: number[] | null;
}

export interface EventCluster {
  event_id: string;
  headline: string | null;
  articles: ClusterArticle[];
}

export interface CoherenceCheckResult {
  passed: boolean;
  score: number;
  failed_checks: string[];
  details: {
    embedding_cohesion: number | null;
    entity_overlap: number | null;
    title_alignment: number | null;
    topic_drift_variance: number | null;
  };
}

// ── Individual checks ───────────────────────────────────────────────

/**
 * Check 1: Embedding Cohesion
 * Average pairwise cosine similarity of article embeddings.
 */
export function checkEmbeddingCohesion(
  articles: ClusterArticle[],
): { score: number; failed: boolean } {
  const vecs = articles
    .map((a) => a.embeddingVec)
    .filter((v): v is number[] => v != null && v.length > 0);

  if (vecs.length < 2) {
    return { score: 1, failed: false };
  }

  let totalSim = 0;
  let pairCount = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      totalSim += cosineSimilarity(vecs[i], vecs[j]);
      pairCount++;
    }
  }

  const avgSim = pairCount > 0 ? totalSim / pairCount : 1;
  return { score: avgSim, failed: avgSim < THETA_EMBEDDING_COHESION };
}

/**
 * Check 2: Entity Overlap
 * Average pairwise Jaccard of extracted title entities.
 */
export function checkEntityOverlap(
  articles: ClusterArticle[],
): { score: number; failed: boolean } {
  if (articles.length < 2) {
    return { score: 1, failed: false };
  }

  const entitySets = articles.map((a) =>
    extractTitleEntities(a.titleRaw ?? a.title),
  );

  let totalJaccard = 0;
  let pairCount = 0;
  for (let i = 0; i < entitySets.length; i++) {
    for (let j = i + 1; j < entitySets.length; j++) {
      totalJaccard += jaccardSets(entitySets[i], entitySets[j]);
      pairCount++;
    }
  }

  const avgJaccard = pairCount > 0 ? totalJaccard / pairCount : 1;
  return { score: avgJaccard, failed: avgJaccard < THETA_ENTITY_OVERLAP };
}

/**
 * Check 3: Title Alignment
 * Jaccard between event headline top terms and aggregated article top terms.
 */
export function checkTitleAlignment(
  headline: string | null,
  articles: ClusterArticle[],
): { score: number; failed: boolean } {
  if (!headline || articles.length === 0) {
    return { score: 1, failed: false };
  }

  const headlineTerms = extractTitleKeywords(headline);
  if (headlineTerms.size === 0) {
    return { score: 1, failed: false };
  }

  // Aggregate top terms from all article titles + first 500 chars of text
  const aggregatedTerms = new Set<string>();
  for (const article of articles) {
    const text = [
      article.title,
      (article.textNorm ?? '').slice(0, 500),
    ].join(' ');
    const terms = extractTitleKeywords(text);
    for (const term of terms) {
      aggregatedTerms.add(term);
    }
  }

  const jaccard = jaccardSets(headlineTerms, aggregatedTerms);
  return { score: jaccard, failed: jaccard < THETA_TITLE_ALIGNMENT };
}

/**
 * Check 4: Topic Drift Variance
 * Standard deviation of cosine distances from centroid.
 * High variance → articles are spread across multiple topics.
 */
export function checkTopicDrift(
  articles: ClusterArticle[],
): { score: number; failed: boolean } {
  const vecs = articles
    .map((a) => a.embeddingVec)
    .filter((v): v is number[] => v != null && v.length > 0);

  if (vecs.length < 2) {
    return { score: 0, failed: false };
  }

  const centroid = computeCentroid(vecs);

  // Compute distances from centroid
  const distances = vecs.map((v) => 1 - cosineSimilarity(v, centroid));

  // Standard deviation
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
  const variance =
    distances.reduce((sum, d) => sum + (d - mean) ** 2, 0) / distances.length;
  const stddev = Math.sqrt(variance);

  return { score: stddev, failed: stddev > THETA_TOPIC_DRIFT };
}

// ── Main gate function ──────────────────────────────────────────────

/**
 * Evaluate all coherence checks for an event cluster.
 * Returns passed=false if MIN_FAILED_CHECKS_TO_BLOCK or more checks fail.
 *
 * Single-article clusters always pass automatically.
 */
export function evaluateClusterCoherence(
  cluster: EventCluster,
): CoherenceCheckResult {
  // Single article or empty → auto-pass
  if (cluster.articles.length <= 1) {
    return {
      passed: true,
      score: 1,
      failed_checks: [],
      details: {
        embedding_cohesion: null,
        entity_overlap: null,
        title_alignment: null,
        topic_drift_variance: null,
      },
    };
  }

  // Gate disabled → auto-pass
  if (!COHERENCE_GATE_ENABLED) {
    return {
      passed: true,
      score: 1,
      failed_checks: [],
      details: {
        embedding_cohesion: null,
        entity_overlap: null,
        title_alignment: null,
        topic_drift_variance: null,
      },
    };
  }

  const failedChecks: string[] = [];

  // 1. Embedding Cohesion
  const embCohesion = checkEmbeddingCohesion(cluster.articles);
  if (embCohesion.failed) failedChecks.push('low_embedding_cohesion');

  // 2. Entity Overlap
  const entityOvlp = checkEntityOverlap(cluster.articles);
  if (entityOvlp.failed) failedChecks.push('low_entity_overlap');

  // 3. Title Alignment
  const titleAlign = checkTitleAlignment(cluster.headline, cluster.articles);
  if (titleAlign.failed) failedChecks.push('title_content_mismatch');

  // 4. Topic Drift Variance
  const topicDrift = checkTopicDrift(cluster.articles);
  if (topicDrift.failed) failedChecks.push('topic_drift');

  // Composite score: average of normalized check scores (0-1, higher = more coherent)
  const scores = [
    embCohesion.score,
    entityOvlp.score,
    titleAlign.score,
    // Invert drift: low drift = high coherence
    Math.max(0, 1 - topicDrift.score),
  ];
  const compositeScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const passed = failedChecks.length < MIN_FAILED_CHECKS_TO_BLOCK;

  logger.info(
    {
      event_id: cluster.event_id,
      coherence_score: compositeScore,
      failed_checks: failedChecks,
      article_count: cluster.articles.length,
      embedding_cohesion: embCohesion.score,
      entity_overlap: entityOvlp.score,
      title_alignment: titleAlign.score,
      topic_drift_variance: topicDrift.score,
      passed,
    },
    'coherence_gate_evaluated',
  );

  return {
    passed,
    score: compositeScore,
    failed_checks: failedChecks,
    details: {
      embedding_cohesion: embCohesion.score,
      entity_overlap: entityOvlp.score,
      title_alignment: titleAlign.score,
      topic_drift_variance: topicDrift.score,
    },
  };
}
