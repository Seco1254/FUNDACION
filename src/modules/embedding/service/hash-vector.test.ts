import { describe, it, expect } from 'vitest';
import { computeEmbedding, computeEmbeddingHash, textForEmbedding, MODEL_NAME } from './hash-vector.js';

describe('hash-vector', () => {
  it('returns a 256-dim vector', () => {
    const vec = computeEmbedding('Colombia reforma tributaria');
    expect(vec).toHaveLength(256);
  });

  it('is deterministic: same input → same output', () => {
    const text = 'Gobierno anuncia reforma tributaria para 2026';
    const v1 = computeEmbedding(text);
    const v2 = computeEmbedding(text);
    expect(v1).toEqual(v2);
  });

  it('produces a unit vector (magnitude ≈ 1)', () => {
    const vec = computeEmbedding('reforma tributaria gobierno');
    const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    expect(magnitude).toBeCloseTo(1.0, 5);
  });

  it('returns zero vector for empty input', () => {
    const vec = computeEmbedding('');
    expect(vec).toHaveLength(256);
    expect(vec.every((v) => v === 0)).toBe(true);
  });

  it('produces different vectors for different text', () => {
    const v1 = computeEmbedding('Colombia reforma tributaria');
    const v2 = computeEmbedding('Argentina fútbol mundial');
    expect(v1).not.toEqual(v2);
  });

  it('computeEmbeddingHash is deterministic', () => {
    const text = 'test hashing';
    const h1 = computeEmbeddingHash(text);
    const h2 = computeEmbeddingHash(text);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64); // sha256 hex
  });

  it('textForEmbedding concatenates title and snippet', () => {
    const result = textForEmbedding('Title', 'Snippet');
    expect(result).toBe('Title Snippet');
  });

  it('exports MODEL_NAME', () => {
    expect(MODEL_NAME).toBe('hash256-v0.2');
  });

  it('filters Spanish stopwords', () => {
    // "el gobierno de la reforma" → only "gobierno" and "reforma" after stopwords
    const vecWithStopwords = computeEmbedding('el gobierno de la reforma');
    const vecWithout = computeEmbedding('gobierno reforma');
    expect(vecWithStopwords).toEqual(vecWithout);
  });

  it('includes bigrams in vector', () => {
    // "reforma tributaria" should produce different vector than "tributaria reforma"
    const v1 = computeEmbedding('reforma tributaria');
    const v2 = computeEmbedding('tributaria reforma');
    expect(v1).not.toEqual(v2);
  });

  it('related articles have higher similarity than unrelated', () => {
    // Two articles about the same topic (reforma tributaria) vs an unrelated one
    const artA = computeEmbedding('Reforma tributaria aprobada en segundo debate por el Congreso colombiano');
    const artB = computeEmbedding('El Congreso aprueba la reforma tributaria tras largo debate legislativo');
    const artC = computeEmbedding('Selección Colombia gana partido eliminatorias mundial fútbol');

    // Cosine similarity
    const cosine = (a: number[], b: number[]) => {
      let dot = 0, mA = 0, mB = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; mA += a[i]*a[i]; mB += b[i]*b[i]; }
      return dot / (Math.sqrt(mA) * Math.sqrt(mB));
    };

    const simAB = cosine(artA, artB); // related
    const simAC = cosine(artA, artC); // unrelated
    expect(simAB).toBeGreaterThan(simAC);
    expect(simAB).toBeGreaterThan(0.3); // should have meaningful overlap
  });
});
