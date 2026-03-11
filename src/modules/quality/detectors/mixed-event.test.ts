import { describe, it, expect } from 'vitest';
import { detectMixedEvent } from './mixed-event.js';

/** Create a unit vector with energy at the given index. */
function makeVec(dim: number, idx: number): number[] {
  const v = new Array(dim).fill(0);
  v[idx % dim] = 1;
  return v;
}

/** Create a normalized vector blending two basis vectors. */
function blendVec(dim: number, idxA: number, idxB: number, ratio = 0.5): number[] {
  const v = new Array(dim).fill(0);
  v[idxA % dim] = ratio;
  v[idxB % dim] = 1 - ratio;
  const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / mag);
}

describe('detectMixedEvent', () => {
  it('returns no flag for single article', () => {
    const result = detectMixedEvent([makeVec(8, 0)]);
    expect(result.mixed_event_flag).toBe(false);
    expect(result.pair_count).toBe(0);
  });

  it('returns no flag for empty embeddings', () => {
    const result = detectMixedEvent([]);
    expect(result.mixed_event_flag).toBe(false);
  });

  it('flags mixed event when articles are orthogonal (two distinct stories)', () => {
    // Two clusters: articles 0,1 point in direction X; articles 2,3 point in direction Y
    const groupA = [makeVec(8, 0), makeVec(8, 0)];
    const groupB = [makeVec(8, 4), makeVec(8, 4)];
    const result = detectMixedEvent([...groupA, ...groupB], 0.5);

    expect(result.mixed_event_flag).toBe(true);
    expect(result.avg_pairwise_sim).toBeLessThan(0.5);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('does NOT flag when all articles are similar', () => {
    const similar = [
      blendVec(8, 0, 1, 0.9),
      blendVec(8, 0, 1, 0.85),
      blendVec(8, 0, 1, 0.95),
    ];
    const result = detectMixedEvent(similar, 0.3);

    expect(result.mixed_event_flag).toBe(false);
    expect(result.avg_pairwise_sim).toBeGreaterThan(0.3);
  });

  it('counts correct number of pairs', () => {
    const vecs = [makeVec(4, 0), makeVec(4, 1), makeVec(4, 2)];
    const result = detectMixedEvent(vecs, 0.5);
    // 3 articles → C(3,2) = 3 pairs
    expect(result.pair_count).toBe(3);
  });

  it('respects custom threshold', () => {
    const vecs = [makeVec(8, 0), makeVec(8, 0)];
    // Identical vectors → sim=1.0, threshold 2.0 would flag
    const strict = detectMixedEvent(vecs, 2.0);
    expect(strict.mixed_event_flag).toBe(true);

    const loose = detectMixedEvent(vecs, 0.5);
    expect(loose.mixed_event_flag).toBe(false);
  });
});
