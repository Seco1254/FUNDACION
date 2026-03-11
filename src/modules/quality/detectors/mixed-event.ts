/**
 * Mixed-event detector — proxy for false merges.
 *
 * If the average pairwise cosine similarity between article embeddings
 * within a single event is below a cohesion threshold, the event likely
 * contains two or more distinct stories merged together.
 */
import { cosineSimilarity } from '../../event_linker/service/similarity.js';

export interface MixedEventResult {
  mixed_event_flag: boolean;
  avg_pairwise_sim: number;
  min_pairwise_sim: number;
  pair_count: number;
  reasons: string[];
}

export function detectMixedEvent(
  embeddings: number[][],
  maxCohesionThreshold: number = 0.3,
): MixedEventResult {
  if (embeddings.length < 2) {
    return {
      mixed_event_flag: false,
      avg_pairwise_sim: 1,
      min_pairwise_sim: 1,
      pair_count: 0,
      reasons: [],
    };
  }

  let totalSim = 0;
  let minSim = 1;
  let pairCount = 0;

  for (let i = 0; i < embeddings.length; i++) {
    for (let j = i + 1; j < embeddings.length; j++) {
      const sim = cosineSimilarity(embeddings[i], embeddings[j]);
      totalSim += sim;
      if (sim < minSim) minSim = sim;
      pairCount++;
    }
  }

  const avgSim = pairCount > 0 ? totalSim / pairCount : 1;
  const reasons: string[] = [];

  if (avgSim < maxCohesionThreshold) {
    reasons.push(
      `avg_pairwise_sim=${avgSim.toFixed(3)} < threshold=${maxCohesionThreshold}`,
    );
  }

  return {
    mixed_event_flag: avgSim < maxCohesionThreshold,
    avg_pairwise_sim: avgSim,
    min_pairwise_sim: minSim,
    pair_count: pairCount,
    reasons,
  };
}
