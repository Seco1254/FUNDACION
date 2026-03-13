/**
 * Product contract: Search (Búsqueda surface).
 *
 * This is the stable shape returned by GET /v1/search.
 * Search results are a simplified subset of FeedCard with search-specific fields.
 *
 * Route: GET /v1/search?q=<query>&limit=20&cursor=<cursor>&topic=<KEY>
 * Params:
 *   q      — required, min 2 chars, max 100 chars
 *   limit  — optional, default 20, max 50
 *   cursor — optional, base64 encoded
 *   topic  — optional, ProductTopicKey to filter results
 */

import type { OverviewConfidenceLabel, FeedCardTopic, FeedCardSource } from './shared.js';

export interface SearchResultItem {
  event_id: string;
  headline: string;
  /** ISO8601 */
  published_at: string;
  updated_at: string | null;

  /**
   * Simplified overview for search result lists.
   * Resolution order:
   *   1. what_happened[0] from overview (first informative bullet)
   *   2. headline as fallback
   *   3. null only if nothing exists (shouldn't happen given NOT NULL headline)
   */
  summary: string | null;
  confidence_label: OverviewConfidenceLabel;

  topic: FeedCardTopic | null;
  sources: FeedCardSource[];
  source_count: number;
  article_count: number;
  evidence_level: 'high' | 'medium' | 'low';

  cover_image_url: string | null;
  /** Headline with <mark>query</mark> markers for highlighting matches. */
  match_headline: string | null;
}

export interface SearchResponse {
  items: SearchResultItem[];
  /** Normalized query (trimmed). */
  query: string;
  next_cursor: string | null;
  meta: {
    has_more: boolean;
  };
}
