export const THETA_JOIN = 0.45;
export const THETA_MERGE = 0.55;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export function computeCentroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dims = vectors[0].length;
  const sum = new Array(dims).fill(0);

  for (const vec of vectors) {
    for (let i = 0; i < dims; i++) {
      sum[i] += vec[i];
    }
  }

  return sum.map((v: number) => v / vectors.length);
}
