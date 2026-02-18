/**
 * Multi-feature event ranking scorer.
 *
 * score(e) = 0.40*I(e) + 0.22*M(e) + 0.18*R(e) + 0.08*Q(e) + 0.06*T(e) - 0.06*J(e)
 *
 * I = Importance  (article count, source diversity)
 * M = Momentum    (rate of new articles over last 6h)
 * R = Recency     (exponential decay from publishedAt)
 * Q = Quality     (avg snippet length, headline presence)
 * T = TopicBoost  (matches hot topics)
 * J = JunkPenalty (avg junk score of articles)
 *
 * All sub-scores are normalized to [0, 1].
 */

import { computeJunkScore, JunkSignals, JUNK_EXCLUDE_THRESHOLD, JUNK_PENALTY_THRESHOLD } from './junk-scorer.js';

// ── Weights ──
const W_IMPORTANCE = 0.40;
const W_MOMENTUM   = 0.22;
const W_RECENCY    = 0.18;
const W_QUALITY    = 0.08;
const W_TOPIC      = 0.06;
const W_JUNK       = 0.06;

// ── Normalization constants ──
const IMPORTANCE_ARTICLE_CAP = 15;  // 15+ articles = max importance
const IMPORTANCE_SOURCE_CAP  = 5;   // 5+ unique sources = max source diversity
const MOMENTUM_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
const MOMENTUM_CAP = 5; // 5+ articles in 6h = max momentum
const RECENCY_HALF_LIFE_MS = 12 * 60 * 60 * 1000; // 12 hours

export interface ArticleForScoring {
  id: string;
  url: string;
  title: string;
  snippet: string;
  mediaId: string;
  publishedAt: Date | null;
  createdAt: Date;
}

export interface EventForScoring {
  id: string;
  publishedAt: Date | null;
  tLast: Date | null;
  t0: Date | null;
  articles: ArticleForScoring[];
  headline: string | null;
  topicKeys: string[];
}

export interface ScoredEvent {
  eventId: string;
  score: number;
  components: {
    importance: number;
    momentum: number;
    recency: number;
    quality: number;
    topicBoost: number;
    junkPenalty: number;
  };
  junkExcluded: boolean;
  avgJunkScore: number;
}

/** Hot topics can be set externally; empty = no boost. */
let hotTopics: Set<string> = new Set();

export function setHotTopics(topics: string[]): void {
  hotTopics = new Set(topics);
}

export function computeEventScore(event: EventForScoring, now: Date = new Date()): ScoredEvent {
  const articles = event.articles;

  // ── I: Importance ──
  const articleCount = articles.length;
  const uniqueSources = new Set(articles.map((a) => a.mediaId)).size;
  const articleFactor = Math.min(articleCount / IMPORTANCE_ARTICLE_CAP, 1);
  const sourceFactor = Math.min(uniqueSources / IMPORTANCE_SOURCE_CAP, 1);
  const importance = 0.6 * articleFactor + 0.4 * sourceFactor;

  // ── M: Momentum ──
  const windowStart = now.getTime() - MOMENTUM_WINDOW_MS;
  const recentArticles = articles.filter((a) => {
    const ts = a.publishedAt?.getTime() ?? a.createdAt.getTime();
    return ts >= windowStart;
  }).length;
  const momentum = Math.min(recentArticles / MOMENTUM_CAP, 1);

  // ── R: Recency ──
  const publishTs = event.publishedAt?.getTime() ?? event.t0?.getTime() ?? now.getTime();
  const ageMs = Math.max(0, now.getTime() - publishTs);
  const recency = Math.exp(-0.693 * ageMs / RECENCY_HALF_LIFE_MS); // ln(2) ≈ 0.693

  // ── Q: Quality ──
  const avgSnippetLen = articles.length > 0
    ? articles.reduce((sum, a) => sum + a.snippet.length, 0) / articles.length
    : 0;
  const snippetQuality = Math.min(avgSnippetLen / 400, 1); // 400+ chars = max quality
  const headlineBonus = event.headline ? 0.3 : 0;
  const quality = Math.min(0.7 * snippetQuality + headlineBonus, 1);

  // ── T: TopicBoost ──
  let topicBoost = 0;
  if (hotTopics.size > 0 && event.topicKeys.length > 0) {
    const matches = event.topicKeys.filter((t) => hotTopics.has(t)).length;
    topicBoost = matches > 0 ? Math.min(matches / 2, 1) : 0;
  }

  // ── J: JunkPenalty ──
  let totalJunk = 0;
  let junkArticleCount = 0;
  for (const a of articles) {
    const junk = computeJunkScore({ url: a.url, title: a.title, snippet: a.snippet });
    totalJunk += junk.score;
    if (junk.score >= JUNK_EXCLUDE_THRESHOLD) junkArticleCount++;
  }
  const avgJunkScore = articles.length > 0 ? totalJunk / articles.length : 0;
  // If majority of articles are junk, exclude the event entirely
  const junkExcluded = articles.length > 0 && (junkArticleCount / articles.length) > 0.5;
  const junkPenalty = avgJunkScore >= JUNK_PENALTY_THRESHOLD ? avgJunkScore : 0;

  // ── Final score ──
  const score = junkExcluded
    ? -1 // sentinel: excluded
    : W_IMPORTANCE * importance
      + W_MOMENTUM * momentum
      + W_RECENCY * recency
      + W_QUALITY * quality
      + W_TOPIC * topicBoost
      - W_JUNK * junkPenalty;

  return {
    eventId: event.id,
    score,
    components: {
      importance,
      momentum,
      recency,
      quality,
      topicBoost,
      junkPenalty,
    },
    junkExcluded,
    avgJunkScore,
  };
}

/**
 * Rank a list of events by score (descending).
 * Excludes junk events. Applies tie-breakers:
 *   1. Higher score first
 *   2. More sources first
 *   3. More recent publishedAt first
 */
export function rankEvents(events: EventForScoring[], now?: Date): ScoredEvent[] {
  const scored = events.map((e) => ({
    event: e,
    result: computeEventScore(e, now),
  }));

  // Filter out junk-excluded events
  const valid = scored.filter((s) => !s.result.junkExcluded);

  // Sort descending by score, then by source count, then by publishedAt
  valid.sort((a, b) => {
    if (b.result.score !== a.result.score) return b.result.score - a.result.score;
    // Tie-breaker 1: more unique sources
    const aSources = new Set(a.event.articles.map((ar) => ar.mediaId)).size;
    const bSources = new Set(b.event.articles.map((ar) => ar.mediaId)).size;
    if (bSources !== aSources) return bSources - aSources;
    // Tie-breaker 2: more recent publishedAt
    const aTs = a.event.publishedAt?.getTime() ?? 0;
    const bTs = b.event.publishedAt?.getTime() ?? 0;
    return bTs - aTs;
  });

  return valid.map((s) => s.result);
}
