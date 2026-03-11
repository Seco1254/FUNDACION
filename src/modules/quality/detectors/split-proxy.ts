/**
 * Split-proxy detector — finds pairs of distinct events that are
 * suspiciously similar (potential false splits).
 *
 * Uses centroid-to-centroid cosine similarity + entity overlap (Jaccard)
 * to flag near-duplicate events that should have been merged.
 */
import { cosineSimilarity } from '../../event_linker/service/similarity.js';

export interface EventForSplit {
  event_id: string;
  centroid: number[];
  entities: Set<string>;
}

export interface SplitPair {
  event_a: string;
  event_b: string;
  centroid_sim: number;
  entity_overlap: number;
}

function entityJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersect = 0;
  for (const e of a) {
    if (b.has(e)) intersect++;
  }
  const union = new Set([...a, ...b]).size;
  return union > 0 ? intersect / union : 0;
}

export function detectSplitPairs(
  events: EventForSplit[],
  minSimilarity: number = 0.75,
  minEntityOverlap: number = 0.15,
): SplitPair[] {
  const pairs: SplitPair[] = [];

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i];
      const b = events[j];
      if (a.centroid.length === 0 || b.centroid.length === 0) continue;

      const sim = cosineSimilarity(a.centroid, b.centroid);
      if (sim < minSimilarity) continue;

      const overlap = entityJaccard(a.entities, b.entities);
      if (overlap >= minEntityOverlap) {
        pairs.push({
          event_a: a.event_id,
          event_b: b.event_id,
          centroid_sim: sim,
          entity_overlap: overlap,
        });
      }
    }
  }

  return pairs;
}
