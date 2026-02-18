// ── Feed ──

export type EventState = 'DETECTED' | 'PENDING_PUBLISH' | 'PUBLISHED' | 'UPDATING' | 'DORMANT' | 'CLOSED';

export interface FeedItem {
  event_id: string;
  state: EventState;
  headline: string | null;
  t_last: string | null;
  published_at: string | null;
  cover_image_url: string | null;
}

export interface FeedResponse {
  items: FeedItem[];
  next_cursor: string | null;
}

// ── Tabs ──

export interface Tab {
  key: string;
  label: string;
}

export interface TabsResponse {
  items: Tab[];
}

// ── Event Detail ──

export interface EventMeta {
  id: string;
  state: EventState;
  t0: string | null;
  t_last: string | null;
  publish_at: string | null;
  published_at: string | null;
  closed_at: string | null;
  canonical_event_id: string | null;
}

export interface CitationRef {
  quote_id: string;
  article_id: string;
  media_key: string;
  url: string;
}

export interface OverviewBullet {
  claim_id: string;
  text: string;
  claim_type: string;
  status: string;
  citation_refs: CitationRef[];
}

export interface OverviewSection {
  title: string;
  key: string;
  bullets: OverviewBullet[];
}

export interface Overview {
  gate_status?: string;
  status?: string;
  sections?: OverviewSection[];
}

export interface ArticleInfo {
  article_id: string;
  media_key: string;
  title: string;
  snippet: string;
  url: string;
  published_at: string | null;
}

export interface QuoteHighlight {
  quote_id: string;
  quote_text: string;
  strength: string;
  claim_id: string;
}

export interface MediaTab {
  media_key: string;
  articles: ArticleInfo[];
  highlights: QuoteHighlight[];
}

export interface BiasLabel {
  media_id?: string;
  article_id?: string;
  label_primary: string;
  label_secondary: string | null;
  intensity: number;
  confidence: number;
  rationale: BiasRationale | null;
  degraded?: boolean;
  degraded_reason?: string;
}

export interface BiasRationale {
  why_short: string;
  why_signals: string[];
  why_quotes: string[];
  top_features: string[];
  signals: string[];
  evidence_refs: { type: string; id: string }[];
}

export interface BiasData {
  media_level: BiasLabel[];
  article_level: BiasLabel[];
}

export interface TopicScore {
  topic_key: string;
  weight: number;
}

export interface TopicsData {
  top_topics: TopicScore[];
  emergent: string[];
}

export interface HeatmapBin {
  bin_index: number;
  bin_start: string;
  bin_end: string;
  topics: Record<string, number>;
}

export interface SubEvent {
  type: string;
  trigger: string;
  detail: Record<string, unknown>;
  detected_at: string;
}

export interface LatestVersion {
  version_index: number;
  gate_status: string;
  headline: string | null;
  packet_json: Record<string, unknown>;
  diff_json: Record<string, unknown>;
}

export interface EventDetailResponse {
  event: EventMeta;
  latest_version: LatestVersion | null;
  media_tabs: MediaTab[];
  overview: Overview;
  bias: BiasData;
  topics: TopicsData;
  topics_heatmap: HeatmapBin[];
  subevents: SubEvent[];
  heatmap: Record<string, unknown>;
}

// ── Bias Endpoint ──

export interface BiasEndpointResponse {
  media_key: string;
  media_level: {
    label_primary: string;
    label_secondary: string | null;
    intensity: number;
    confidence: number;
    rationale: BiasRationale | null;
  } | null;
  article_level: {
    article_id: string;
    label_primary: string;
    label_secondary: string | null;
    intensity: number;
    confidence: number;
    rationale: BiasRationale | null;
  }[];
}

// ── Health ──

export interface HealthResponse {
  ok: boolean;
  time: string;
}

// ── Local types ──

export interface ViewedEvent {
  event_id: string;
  headline: string | null;
  state: EventState;
  t_last: string | null;
  viewed_at: string;
}

export interface CustomTopic {
  key: string;
  label: string;
}
