import type { EvidenceLevel } from '../service/evidence-level.js';

export interface AnalisisFuentes {
  consenso: string[];
  desacuerdo: string[];
  informacion_faltante: string[];
}

export interface FeedItemOverview {
  overview?: string;
  what_happened: string[];
  context: string[];
  in_dispute: string[];
  confidence_label: string;
  analisis_fuentes?: AnalisisFuentes;
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
  topic_key?: string;
  topic_confidence?: number;
  importance_score?: number;
}

export type EmptyReason = 'NO_EVENTS' | 'NO_PUBLISHED' | 'GATE_FILTERED_ALL' | 'DB_EMPTY';

export interface FeedResponse {
  items: FeedItem[];
  next_cursor: string | null;
  empty_reason?: EmptyReason;
}
