export interface FeedItemOverview {
  what_happened: string[];
  context: string[];
  in_dispute: string[];
  confidence_label: string;
}

export interface FeedItem {
  event_id: string;
  state: string;
  headline: string | null;
  t_last: string | null;
  published_at: string | null;
  cover_image_url: string | null;
  ai_overview?: FeedItemOverview | null;
  source_count?: number;
}

export interface FeedResponse {
  items: FeedItem[];
  next_cursor: string | null;
}
