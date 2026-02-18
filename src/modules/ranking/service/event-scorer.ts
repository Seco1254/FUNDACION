/**
 * Multi-feature event ranking scorer — spec-exact implementation.
 *
 * score(e) = 0.40*I(e) + 0.22*M(e) + 0.18*R(e) + 0.08*Q(e) + 0.06*T(e) - 0.06*J(e)
 *
 * I = sigmoid( log(1+n_arts_eff) * log(1+n_unique_media) )
 *     n_arts_eff = sum over media min(articles_by_media, 3)
 *     If one media dominates >70% of total articles → -0.05 penalty on final score
 *
 * M = sigmoid( Δn_arts_6h + 2*Δn_unique_media_6h )
 *     Articles with junk_score >= 0.45 do NOT count for momentum.
 *
 * R = exp(-0.693 * age_ms / HALF_LIFE_MS)    (12h half-life)
 *
 * Q = min(1, claims_supported / max(1, claims_total))
 *     claims_supported = claims with status SUPPORTED
 *     If no claims: Q = 0
 *
 * T = topic boost (configurable hot topics)
 *
 * J = avg(junk_score) across all articles (0..1)
 *     junk_score >= 0.75 → article excluded from feed entirely
 *     0.45–0.75 → penalizes ranking, doesn't count in momentum
 *     < 0.45 → normal
 *     Events where ALL non-excluded articles are gone → event excluded
 *
 * Tie-breakers (exact order):
 *   1. unique media desc
 *   2. updates in 6h desc
 *   3. most recent publishedAt
 */

import { computeJunkScore, JUNK_EXCLUDE_THRESHOLD, JUNK_PENALTY_THRESHOLD } from './junk-scorer.js';

// ── Weights ──
const W_IMPORTANCE = 0.40;
const W_MOMENTUM   = 0.22;
const W_RECENCY    = 0.18;
const W_QUALITY    = 0.08;
const W_TOPIC      = 0.06;
const W_JUNK       = 0.06;

// ── Constants ──
const PER_MEDIA_CAP = 3;
const DOMINANCE_THRESHOLD = 0.70;
const DOMINANCE_PENALTY = 0.05;
const MOMENTUM_WINDOW_MS = 6 * 60 * 60 * 1000; // 6 hours
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

export interface ClaimForScoring {
  status: string; // 'SUPPORTED' | 'DISPUTED' | 'INSUFFICIENT'
}

export interface EventForScoring {
  id: string;
  publishedAt: Date | null;
  tLast: Date | null;
  t0: Date | null;
  articles: ArticleForScoring[];
  headline: string | null;
  topicKeys: string[];
  claims: ClaimForScoring[];
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
  uniqueMediaCount: number;
  updatesIn6h: number;
  dominancePenalty: boolean;
}

/** Hot topics can be set externally; empty = no boost. */
let hotTopics: Set<string> = new Set();

export function setHotTopics(topics: string[]): void {
  hotTopics = new Set(topics);
}

/** Standard sigmoid: 1 / (1 + exp(-x)) */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/**
 * Compute per-article junk scores and classify.
 * Returns articles split into: included (junk < 0.75) and excluded (junk >= 0.75).
 */
function classifyArticles(articles: ArticleForScoring[]): {
  included: Array<ArticleForScoring & { junkScore: number }>;
  excluded: ArticleForScoring[];
  totalJunk: number;
} {
  const included: Array<ArticleForScoring & { junkScore: number }> = [];
  const excluded: ArticleForScoring[] = [];
  let totalJunk = 0;

  for (const a of articles) {
    const junk = computeJunkScore({ url: a.url, title: a.title, snippet: a.snippet });
    totalJunk += junk.score;
    if (junk.score >= JUNK_EXCLUDE_THRESHOLD) {
      excluded.push(a);
    } else {
      included.push({ ...a, junkScore: junk.score });
    }
  }

  return { included, excluded, totalJunk };
}

export function computeEventScore(event: EventForScoring, now: Date = new Date()): ScoredEvent {
  const articles = event.articles;
  const { included, excluded, totalJunk } = classifyArticles(articles);

  // If ALL articles are excluded (junk >= 0.75), event does not appear
  const junkExcluded = included.length === 0 && articles.length > 0;
  const avgJunkScore = articles.length > 0 ? totalJunk / articles.length : 0;

  if (junkExcluded) {
    return {
      eventId: event.id,
      score: -1,
      components: { importance: 0, momentum: 0, recency: 0, quality: 0, topicBoost: 0, junkPenalty: avgJunkScore },
      junkExcluded: true,
      avgJunkScore,
      uniqueMediaCount: 0,
      updatesIn6h: 0,
      dominancePenalty: false,
    };
  }

  // ── I: Importance ──
  // n_arts_eff = sum over media min(articles_by_media, PER_MEDIA_CAP)
  const articlesByMedia = new Map<string, number>();
  for (const a of included) {
    articlesByMedia.set(a.mediaId, (articlesByMedia.get(a.mediaId) ?? 0) + 1);
  }
  let nArtsEff = 0;
  for (const count of articlesByMedia.values()) {
    nArtsEff += Math.min(count, PER_MEDIA_CAP);
  }
  const nUniqueMedia = articlesByMedia.size;

  const importance = sigmoid(Math.log(1 + nArtsEff) * Math.log(1 + nUniqueMedia));

  // Dominance check: any single media >70% of ALL articles (not capped)
  let dominancePenalty = false;
  const totalArticlesByMedia = new Map<string, number>();
  for (const a of articles) {
    totalArticlesByMedia.set(a.mediaId, (totalArticlesByMedia.get(a.mediaId) ?? 0) + 1);
  }
  for (const count of totalArticlesByMedia.values()) {
    if (articles.length > 0 && count / articles.length > DOMINANCE_THRESHOLD) {
      dominancePenalty = true;
      break;
    }
  }

  // ── M: Momentum ──
  // Only count articles with junk_score < JUNK_PENALTY_THRESHOLD (0.45)
  const windowStart = now.getTime() - MOMENTUM_WINDOW_MS;
  const momentumArticles = included.filter((a) => {
    if (a.junkScore >= JUNK_PENALTY_THRESHOLD) return false; // junk 0.45+ doesn't count
    const ts = a.publishedAt?.getTime() ?? a.createdAt.getTime();
    return ts >= windowStart;
  });
  const deltaArts6h = momentumArticles.length;
  const deltaUniqueMedia6h = new Set(momentumArticles.map((a) => a.mediaId)).size;
  const momentum = sigmoid(deltaArts6h + 2 * deltaUniqueMedia6h);

  // ── R: Recency ──
  const publishTs = event.publishedAt?.getTime() ?? event.t0?.getTime() ?? now.getTime();
  const ageMs = Math.max(0, now.getTime() - publishTs);
  const recency = Math.exp(-0.693 * ageMs / RECENCY_HALF_LIFE_MS);

  // ── Q: Quality ──
  // Q = min(1, claims_supported / max(1, claims_total))
  const claimsTotal = event.claims.length;
  const claimsSupported = event.claims.filter((c) => c.status === 'SUPPORTED').length;
  const quality = claimsTotal === 0 ? 0 : Math.min(1, claimsSupported / Math.max(1, claimsTotal));

  // ── T: TopicBoost ──
  let topicBoost = 0;
  if (hotTopics.size > 0 && event.topicKeys.length > 0) {
    const matches = event.topicKeys.filter((t) => hotTopics.has(t)).length;
    topicBoost = matches > 0 ? Math.min(matches / 2, 1) : 0;
  }

  // ── J: JunkPenalty ── avg junk_score of ALL articles (0..1)
  const junkPenalty = avgJunkScore;

  // ── Final score ──
  let score =
    W_IMPORTANCE * importance
    + W_MOMENTUM * momentum
    + W_RECENCY * recency
    + W_QUALITY * quality
    + W_TOPIC * topicBoost
    - W_JUNK * junkPenalty;

  if (dominancePenalty) {
    score -= DOMINANCE_PENALTY;
  }

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
    junkExcluded: false,
    avgJunkScore,
    uniqueMediaCount: nUniqueMedia,
    updatesIn6h: deltaArts6h,
    dominancePenalty,
  };
}

/**
 * Rank a list of events by score (descending).
 * Excludes events where all articles have junk_score >= 0.75.
 *
 * Tie-breakers (exact order):
 *   1. unique media desc
 *   2. updates in 6h desc
 *   3. most recent publishedAt
 */
export function rankEvents(events: EventForScoring[], now?: Date): ScoredEvent[] {
  const scored = events.map((e) => ({
    event: e,
    result: computeEventScore(e, now),
  }));

  // Filter out junk-excluded events
  const valid = scored.filter((s) => !s.result.junkExcluded);

  // Sort: score desc, then tie-breakers
  valid.sort((a, b) => {
    // Primary: score desc
    const scoreDiff = b.result.score - a.result.score;
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;

    // Tie-breaker 1: unique media desc
    if (b.result.uniqueMediaCount !== a.result.uniqueMediaCount) {
      return b.result.uniqueMediaCount - a.result.uniqueMediaCount;
    }

    // Tie-breaker 2: updates in 6h desc
    if (b.result.updatesIn6h !== a.result.updatesIn6h) {
      return b.result.updatesIn6h - a.result.updatesIn6h;
    }

    // Tie-breaker 3: most recent publishedAt
    const aTs = a.event.publishedAt?.getTime() ?? 0;
    const bTs = b.event.publishedAt?.getTime() ?? 0;
    return bTs - aTs;
  });

  return valid.map((s) => s.result);
}
