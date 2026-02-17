import weightsData from '../model/weights_v0_1.json' with { type: 'json' };
import type { FeatureVector, RationaleJson } from '../domain/types.js';

const WEIGHTS = weightsData;
const featureSets = WEIGHTS.features;

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function countMatches(text: string, words: string[]): number {
  let count = 0;
  for (const w of words) {
    const regex = new RegExp(`\\b${w}\\b`, 'gi');
    const matches = text.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

export function extractFeatures(text: string): FeatureVector {
  const lower = stripAccents(text.toLowerCase());
  const wordCount = lower.split(/\s+/).length || 1;

  const emotional = countMatches(lower, featureSets.emotional_words) / wordCount;
  const critical = countMatches(lower, featureSets.critical_words) / wordCount;
  const negation = countMatches(lower, featureSets.negation_words) / wordCount;
  const institutional = countMatches(lower, featureSets.institutional_words) / wordCount;
  const technical = countMatches(lower, featureSets.technical_words) / wordCount;
  const attribution = countMatches(lower, featureSets.attribution_words) / wordCount;
  const pro_gov = countMatches(lower, featureSets.pro_gov_words) / wordCount;
  const anti_gov = countMatches(lower, featureSets.anti_gov_words) / wordCount;

  return { emotional, critical, negation, institutional, technical, attribution, pro_gov, anti_gov };
}

export function classifyPrimary(features: FeatureVector): { label: string; confidence: number; scores: Record<string, number> } {
  const scores: Record<string, number> = {};

  for (const [label, w] of Object.entries(WEIGHTS.weights)) {
    const weights = w as Record<string, number>;
    let score = 0;
    score += (weights.emotional ?? 0) * features.emotional;
    score += (weights.critical ?? 0) * features.critical;
    score += (weights.negation ?? 0) * features.negation;
    score += (weights.institutional ?? 0) * features.institutional;
    score += (weights.technical ?? 0) * features.technical;
    score += (weights.bias ?? 0) * (features.pro_gov - features.anti_gov);
    scores[label] = score;
  }

  // Softmax for confidence
  const maxScore = Math.max(...Object.values(scores));
  const expScores: Record<string, number> = {};
  let expSum = 0;
  for (const [label, score] of Object.entries(scores)) {
    const exp = Math.exp(score - maxScore);
    expScores[label] = exp;
    expSum += exp;
  }

  let bestLabel = 'NO_CONCLUYENTE';
  let bestConf = 0;
  for (const [label, exp] of Object.entries(expScores)) {
    const conf = exp / expSum;
    if (conf > bestConf) {
      bestConf = conf;
      bestLabel = label;
    }
  }

  // If confidence below threshold, return NO_CONCLUYENTE
  if (bestConf < WEIGHTS.thresholds.primary_min_confidence) {
    bestLabel = 'NO_CONCLUYENTE';
  }

  return { label: bestLabel, confidence: bestConf, scores };
}

export function classifySecondary(features: FeatureVector): { label: string | null; confidence: number } {
  const scores: Record<string, number> = {};

  for (const [label, w] of Object.entries(WEIGHTS.secondary_weights)) {
    const weights = w as Record<string, number>;
    let score = 0;
    score += (weights.pro_gov ?? 0) * features.pro_gov;
    score += (weights.anti_gov ?? 0) * features.anti_gov;
    score += (weights.critical ?? 0) * features.critical;
    score += (weights.institutional ?? 0) * features.institutional;
    scores[label] = score;
  }

  const maxScore = Math.max(...Object.values(scores));
  const expScores: Record<string, number> = {};
  let expSum = 0;
  for (const [label, score] of Object.entries(scores)) {
    const exp = Math.exp(score - maxScore);
    expScores[label] = exp;
    expSum += exp;
  }

  let bestLabel: string | null = null;
  let bestConf = 0;
  for (const [label, exp] of Object.entries(expScores)) {
    const conf = exp / expSum;
    if (conf > bestConf) {
      bestConf = conf;
      bestLabel = label;
    }
  }

  if (bestConf < WEIGHTS.thresholds.secondary_min_confidence) {
    return { label: null, confidence: bestConf };
  }

  return { label: bestLabel, confidence: bestConf };
}

export function computeIntensity(features: FeatureVector): number {
  // Intensity = magnitude of feature vector, clamped to [0,1]
  const sum = features.emotional + features.critical + features.negation +
    features.institutional + features.technical + features.attribution;
  return Math.min(1, Math.max(0, sum * 5)); // Scale up for normalization
}

export function buildSignals(features: FeatureVector): string[] {
  const signals: string[] = [];
  if (features.emotional > 0.02) signals.push('lenguaje emocional');
  if (features.critical > 0.02) signals.push('tono valorativo');
  if (features.attribution > 0.02) signals.push('atribuciones');
  if (features.institutional > 0.02) signals.push('lenguaje institucional');
  if (features.technical > 0.02) signals.push('lenguaje técnico');
  if (features.pro_gov > 0.01) signals.push('agenda pro-gobierno');
  if (features.anti_gov > 0.01) signals.push('agenda anti-gobierno');
  if (features.negation > 0.03) signals.push('negación frecuente');
  if (signals.length === 0) signals.push('sin señales destacadas');
  return signals;
}

export function buildTopFeatures(features: FeatureVector): string[] {
  const entries: [string, number][] = Object.entries(features);
  return entries
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${v.toFixed(4)}`);
}

export function buildRationale(
  features: FeatureVector,
  primaryLabel: string,
  quotes: { quote_id: string; text: string; url: string }[],
  evidenceRefs: { type: 'quote' | 'claim' | 'article'; id: string }[],
): RationaleJson {
  const signals = buildSignals(features);
  const topFeatures = buildTopFeatures(features);
  const whyQuotes = quotes.slice(0, 2);

  let whyShort: string;
  if (primaryLabel === 'NEUTRO' || primaryLabel === 'NO_CONCLUYENTE') {
    whyShort = 'El artículo no presenta señales significativas de sesgo detectable.';
  } else {
    whyShort = `Clasificado como ${primaryLabel} por señales de ${signals.slice(0, 2).join(' y ')}.`;
  }

  return {
    why_short: whyShort,
    why_signals: signals,
    why_quotes: whyQuotes,
    top_features: topFeatures,
    signals,
    evidence_refs: evidenceRefs,
  };
}
