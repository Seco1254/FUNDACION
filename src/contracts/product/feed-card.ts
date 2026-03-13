/**
 * Product contract: Feed Card (For You surface).
 *
 * This is the stable shape returned by GET /v1/feed.
 * Frontend consumers build against this contract.
 */

import type { OverviewConfidenceLabel, FeedCardTopic, FeedCardSource } from './shared.js';

export interface FeedCardOverview {
  status: 'ready' | 'pending' | 'unavailable';
  /** At least 1 element (headline as minimum fallback). */
  what_happened: string[];
  context: string[];
  in_dispute: string[];
  confidence_label: OverviewConfidenceLabel;
}

export interface FeedCard {
  event_id: string;
  /** NOT NULL — guaranteed by repo query + adapter. */
  headline: string;
  /** ISO8601, NOT NULL — guaranteed by repo query + adapter. */
  published_at: string;
  /** ISO8601 or null. Renamed from t_last. */
  updated_at: string | null;

  overview: FeedCardOverview;

  /** Primary topic. null only if pipeline hasn't assigned yet. */
  topic: FeedCardTopic | null;
  /** At least 1 source (guaranteed by publish gate). */
  sources: FeedCardSource[];
  /** Convenience: === sources.length */
  source_count: number;
  /** Total articles linked to this event. */
  article_count: number;
  /** 'none' is filtered by gate — never reaches feed. */
  evidence_level: 'high' | 'medium' | 'low';

  cover_image_url: string | null;
}

export interface FeedResponse {
  items: FeedCard[];
  next_cursor: string | null;
  meta: {
    has_more: boolean;
    /** Only set when items is empty. */
    empty_reason?: 'no_events' | 'no_published';
  };
}
