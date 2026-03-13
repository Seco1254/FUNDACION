/**
 * Product contract: Topics (Temas surface).
 *
 * This is the stable shape returned by GET /v1/topics.
 * OTROS is excluded — it's an internal fallback, not a product category.
 */

import type { ProductTopicKey } from './shared.js';

export interface TopicSummary {
  /** One of the 12 visible product topic keys. */
  key: ProductTopicKey;
  label: string;
  /** Count of PUBLISHED events with this topic. */
  event_count: number;
}

export interface TopicsResponse {
  /** Ordered by event_count DESC. */
  items: TopicSummary[];
}

/**
 * Frontend-only model for local topic preference persistence.
 * Storage key: "fundacion:topic_prefs"
 * The backend does NOT store user preferences.
 */
export interface TopicPreference {
  key: ProductTopicKey;
  /** true = user wants to see this topic. */
  enabled: boolean;
  /** true = appears as a quick-access tab. */
  pinned: boolean;
}
