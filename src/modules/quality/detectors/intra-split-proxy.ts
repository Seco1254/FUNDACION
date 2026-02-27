/**
 * Intra-event split proxy detector — flags events whose articles
 * span multiple topics or desks, suggesting a false merge.
 *
 * Uses topic histogram + desk histogram per article within an event.
 * Flags split_proxy=true if:
 *   - top_topic_share < 0.6  OR
 *   - top_desk_share < 0.6
 *
 * Pure function, no DB dependency — designed for deterministic unit testing.
 */

import { classifyTopic, type HeuristicTopicInput } from '../../topics/service/topic-heuristic.js';
import { extractDesk } from '../../event_linker/service/hard-negative-gates.js';

export interface ArticleForIntraSplit {
  title?: string | null;
  url?: string | null;
  contentType?: string | null;
}

export interface IntraSplitResult {
  split_proxy: boolean;
  top_topic: string | null;
  top_topic_share: number;
  top_desk: string | null;
  top_desk_share: number;
  topic_histogram: Record<string, number>;
  desk_histogram: Record<string, number>;
  reasons: string[];
}

const TOPIC_SHARE_THRESHOLD = 0.6;
const DESK_SHARE_THRESHOLD = 0.6;

/**
 * Detect whether an event's articles suggest a false merge.
 * Requires at least 3 articles with classifiable signals.
 */
export function detectIntraSplitProxy(
  articles: ArticleForIntraSplit[],
): IntraSplitResult {
  const noSplit: IntraSplitResult = {
    split_proxy: false,
    top_topic: null,
    top_topic_share: 0,
    top_desk: null,
    top_desk_share: 0,
    topic_histogram: {},
    desk_histogram: {},
    reasons: [],
  };

  if (articles.length < 3) return noSplit;

  // Build topic histogram
  const topicCounts: Record<string, number> = {};
  for (const art of articles) {
    const input: HeuristicTopicInput = {
      title: art.title,
      url: art.url,
      contentType: art.contentType,
    };
    const result = classifyTopic(input);
    topicCounts[result.topic_key] = (topicCounts[result.topic_key] ?? 0) + 1;
  }

  // Build desk histogram
  const deskCounts: Record<string, number> = {};
  let deskClassified = 0;
  for (const art of articles) {
    const desk = extractDesk(art.url);
    if (desk) {
      deskCounts[desk] = (deskCounts[desk] ?? 0) + 1;
      deskClassified++;
    }
  }

  // Compute shares
  const totalArticles = articles.length;
  const topicEntries = Object.entries(topicCounts).sort((a, b) => b[1] - a[1]);
  const topTopic = topicEntries[0]?.[0] ?? null;
  const topTopicCount = topicEntries[0]?.[1] ?? 0;
  const topTopicShare = totalArticles > 0 ? topTopicCount / totalArticles : 0;

  const deskEntries = Object.entries(deskCounts).sort((a, b) => b[1] - a[1]);
  const topDesk = deskEntries[0]?.[0] ?? null;
  const topDeskCount = deskEntries[0]?.[1] ?? 0;
  // Desk share computed over articles WITH desk classification
  const topDeskShare = deskClassified > 0 ? topDeskCount / deskClassified : 1.0;

  const reasons: string[] = [];
  let splitProxy = false;

  if (topTopicShare < TOPIC_SHARE_THRESHOLD) {
    reasons.push(`TOPIC_FRAGMENTED:${topTopic}(${(topTopicShare * 100).toFixed(0)}%)`);
    splitProxy = true;
  }

  // Only check desk share if we have enough classified articles (>= 3)
  if (deskClassified >= 3 && topDeskShare < DESK_SHARE_THRESHOLD) {
    reasons.push(`DESK_FRAGMENTED:${topDesk}(${(topDeskShare * 100).toFixed(0)}%)`);
    splitProxy = true;
  }

  return {
    split_proxy: splitProxy,
    top_topic: topTopic,
    top_topic_share: Math.round(topTopicShare * 1000) / 1000,
    top_desk: topDesk,
    top_desk_share: Math.round(topDeskShare * 1000) / 1000,
    topic_histogram: topicCounts,
    desk_histogram: deskCounts,
    reasons,
  };
}
