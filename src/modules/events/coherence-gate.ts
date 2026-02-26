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

export interface CoherenceMetrics {
  avg_cosine: number | null;
  entity_jaccard: number | null;
  title_jaccard: number | null;
  stddev_drift: number | null;
  article_count: number;
}

export interface CoherenceThresholds {
  min_avg_cosine: number;
  min_entity_jaccard: number;
  min_title_jaccard: number;
  max_stddev_drift: number;
}

export interface CoherenceGatePacket {
  status: 'PASS' | 'FAIL';
  failed_checks: string[];
  metrics: CoherenceMetrics;
  thresholds: CoherenceThresholds;
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
  metrics: CoherenceMetrics;
  thresholds: CoherenceThresholds;
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

/**
 * Build the current thresholds snapshot (frozen at call time).
 */
export function currentThresholds(): CoherenceThresholds {
  return {
    min_avg_cosine: THETA_EMBEDDING_COHESION,
    min_entity_jaccard: THETA_ENTITY_OVERLAP,
    min_title_jaccard: THETA_TITLE_ALIGNMENT,
    max_stddev_drift: THETA_TOPIC_DRIFT,
  };
}

// ── Main gate function ──────────────────────────────────────────────

/**
 * Evaluate all coherence checks for an event cluster.
 * Returns passed=false if MIN_FAILED_CHECKS_TO_BLOCK or more checks fail.
 *
 * Single-article clusters always pass automatically.
 * Metrics and thresholds are ALWAYS populated for observability.
 */
export function evaluateClusterCoherence(
  cluster: EventCluster,
): CoherenceCheckResult {
  const thresholds = currentThresholds();
  const articleCount = cluster.articles.length;

  // Single article or empty → auto-pass (metrics null for pairwise, computed where possible)
  if (articleCount <= 1) {
    const titleScore = articleCount === 1 && cluster.headline
      ? checkTitleAlignment(cluster.headline, cluster.articles).score
      : null;

    return {
      passed: true,
      score: 1,
      failed_checks: [],
      details: {
        embedding_cohesion: null,
        entity_overlap: null,
        title_alignment: titleScore,
        topic_drift_variance: null,
      },
      metrics: {
        avg_cosine: null,
        entity_jaccard: null,
        title_jaccard: titleScore,
        stddev_drift: null,
        article_count: articleCount,
      },
      thresholds,
    };
  }

  const failedChecks: string[] = [];

  // 1. Embedding Cohesion
  const embCohesion = checkEmbeddingCohesion(cluster.articles);
  const hasVecs = cluster.articles.some((a) => a.embeddingVec != null && a.embeddingVec.length > 0);
  const avgCosine = hasVecs ? embCohesion.score : null;

  // 2. Entity Overlap
  const entityOvlp = checkEntityOverlap(cluster.articles);

  // 3. Title Alignment
  const titleAlign = checkTitleAlignment(cluster.headline, cluster.articles);

  // 4. Topic Drift Variance
  const topicDrift = checkTopicDrift(cluster.articles);
  const stddevDrift = hasVecs ? topicDrift.score : null;

  // Only apply gate logic if enabled
  if (COHERENCE_GATE_ENABLED) {
    if (embCohesion.failed) failedChecks.push('low_embedding_cohesion');
    if (entityOvlp.failed) failedChecks.push('low_entity_overlap');
    if (titleAlign.failed) failedChecks.push('title_content_mismatch');
    if (topicDrift.failed) failedChecks.push('topic_drift');
  }

  // Composite score: average of normalized check scores (0-1, higher = more coherent)
  const scores = [
    embCohesion.score,
    entityOvlp.score,
    titleAlign.score,
    // Invert drift: low drift = high coherence
    Math.max(0, 1 - topicDrift.score),
  ];
  const compositeScore = scores.reduce((a, b) => a + b, 0) / scores.length;

  const passed = !COHERENCE_GATE_ENABLED || failedChecks.length < MIN_FAILED_CHECKS_TO_BLOCK;

  const metrics: CoherenceMetrics = {
    avg_cosine: avgCosine,
    entity_jaccard: entityOvlp.score,
    title_jaccard: titleAlign.score,
    stddev_drift: stddevDrift,
    article_count: articleCount,
  };

  logger.info(
    {
      event_id: cluster.event_id,
      coherence_score: compositeScore,
      failed_checks: failedChecks,
      article_count: articleCount,
      avg_cosine: metrics.avg_cosine,
      entity_jaccard: metrics.entity_jaccard,
      title_jaccard: metrics.title_jaccard,
      stddev_drift: metrics.stddev_drift,
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
    metrics,
    thresholds,
  };
}

/**
 * Build the coherence_gate packet object for persistence in packet_json.
 * Always includes metrics + thresholds regardless of PASS/FAIL.
 */
export function buildCoherenceGatePacket(
  result: CoherenceCheckResult,
): CoherenceGatePacket {
  return {
    status: result.passed ? 'PASS' : 'FAIL',
    failed_checks: result.failed_checks,
    metrics: result.metrics,
    thresholds: result.thresholds,
  };
}
