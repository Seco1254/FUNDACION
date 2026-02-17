export interface FeedItem {
  event_id: string;
  state: string;
  headline: string | null;
  t_last: string | null;
  published_at: string | null;
  cover_image_url: string | null;
}

export interface FeedResponse {
  items: FeedItem[];
  next_cursor: string | null;
}
