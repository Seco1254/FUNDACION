import { createHash } from 'crypto';

const DIMS = 256;
const MODEL_NAME = 'hash256-v0.2';

/**
 * Spanish stopwords — function words that dominate BoW vectors
 * without contributing discriminative signal.
 */
const ES_STOPWORDS = new Set([
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas',
  'de', 'del', 'al', 'en', 'con', 'por', 'para', 'que',
  'se', 'su', 'sus', 'lo', 'le', 'les', 'nos', 'me',
  'es', 'son', 'fue', 'ser', 'hay', 'ha', 'han', 'sido',
  'más', 'pero', 'como', 'ya', 'o', 'y', 'e', 'ni',
  'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa',
  'eso', 'esos', 'esas', 'aquel', 'aquella',
  'no', 'si', 'sí', 'muy', 'también', 'entre', 'sobre',
  'todo', 'toda', 'todos', 'todas', 'otro', 'otra', 'otros',
  'cada', 'donde', 'cuando', 'cual', 'quien',
  'desde', 'hasta', 'según', 'sin', 'ante', 'bajo', 'tras',
  'tiene', 'hace', 'dice', 'está', 'están', 'será', 'puede',
  'dijo', 'hecho', 'bien', 'solo', 'aquí', 'allí',
]);

function hashToken(token: string): number {
  let hash = 0;
  for (let i = 0; i < token.length; i++) {
    hash = ((hash << 5) - hash + token.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % DIMS;
}

/**
 * Compute a 256-dimensional bag-of-words hash embedding.
 *
 * v0.2 improvements over v0.1:
 * - Spanish stopword removal — eliminates noise from function words
 * - Bigram features — captures phrase-level signal ("reforma tributaria")
 *   to reduce hash collisions and improve discriminative power
 */
export function computeEmbedding(text: string): number[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !ES_STOPWORDS.has(t));

  const vec = new Array(DIMS).fill(0);

  // Unigrams
  for (const token of tokens) {
    vec[hashToken(token)]++;
  }

  // Bigrams — captures phrase-level signal
  for (let i = 0; i < tokens.length - 1; i++) {
    vec[hashToken(`${tokens[i]}_${tokens[i + 1]}`)]++;
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
