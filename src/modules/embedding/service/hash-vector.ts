import { createHash } from 'crypto';

const DIMS = 256;
const MODEL_NAME = 'hash256-v0.1';

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % DIMS;
}

export function computeEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const vec = new Array(DIMS).fill(0);
  for (const token of tokens) {
    vec[hashToken(token)]++;
  }

  const magnitude = Math.sqrt(vec.reduce((sum: number, v: number) => sum + v * v, 0));
  if (magnitude === 0) return vec;
  return vec.map((v: number) => v / magnitude);
}

export function computeEmbeddingHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function textForEmbedding(title: string, snippet: string): string {
  return `${title} ${snippet}`;
}

export { MODEL_NAME };
