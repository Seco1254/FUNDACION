import type { EvidenceLevel } from '../service/evidence-level.js';

export interface FeedItemOverview {
  what_happened: string[];
  context: string[];
  in_dispute: string[];
  confidence_label: string;
}

export interface FeedItemSource {
  source_id: string;
  name: string;
  domain: string;
  article_count: number;
}

export interface FeedItem {
  event_id: string;
  state: string;
  headline: string | null;
  t_last: string | null;
  published_at: string | null;
  cover_image_url: string | null;
  ai_overview?: FeedItemOverview | null;
  overview_status?: 'ready' | 'unavailable' | 'pending' | 'failed';
  source_count?: number;
  sources?: FeedItemSource[];
  article_count?: number;
  unique_sources_count?: number;
  usable_articles_count?: number;
  total_usable_text_len?: number;
  key_facts_count?: number;
  evidence_level?: EvidenceLevel;
  overview_mode?: string | null;
  why_no_overview?: string | null;
}

export interface FeedResponse {
  items: FeedItem[];
  next_cursor: string | null;
}
