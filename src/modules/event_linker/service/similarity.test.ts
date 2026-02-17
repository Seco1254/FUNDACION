import { describe, it, expect } from 'vitest';
import { cosineSimilarity, computeCentroid, THETA_JOIN, THETA_MERGE } from './similarity.js';

describe('similarity', () => {
  it('cosine of identical vectors is 1', () => {
    const a = [1, 0, 0];
    expect(cosineSimilarity(a, a)).toBeCloseTo(1.0, 10);
  });

  it('cosine of orthogonal vectors is 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 10);
  });

  it('cosine of opposite vectors is -1', () => {
    const a = [1, 0, 0];
    const b = [-1, 0, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 10);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1])).toBe(0);
  });

  it('computes centroid as average', () => {
    const vecs = [
      [2, 4, 6],
      [4, 6, 8],
    ];
    const c = computeCentroid(vecs);
    expect(c).toEqual([3, 5, 7]);
  });

  it('centroid of single vector is itself', () => {
    const c = computeCentroid([[1, 2, 3]]);
    expect(c).toEqual([1, 2, 3]);
  });

  it('centroid of empty array is empty', () => {
    expect(computeCentroid([])).toEqual([]);
  });

  it('exports correct thresholds', () => {
    expect(THETA_JOIN).toBe(0.45);
    expect(THETA_MERGE).toBe(0.55);
  });
});
