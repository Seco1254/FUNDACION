import { FeedRepository } from '../repo/feed-repo.js';
import { FeedItem, FeedResponse } from '../domain/types.js';

const PAGE_SIZE = 20;

export class FeedService {
  constructor(private repo: FeedRepository) {}

  async getFeed(cursorStr?: string): Promise<FeedResponse> {
    let cursor: { publishedAt: Date; eventId: string } | undefined;

    if (cursorStr) {
      const decoded = Buffer.from(cursorStr, 'base64').toString('utf-8');
      const [publishedAtStr, eventId] = decoded.split('|');
      if (publishedAtStr && eventId) {
        cursor = { publishedAt: new Date(publishedAtStr), eventId };
      }
    }

    const rows = await this.repo.getFeed(cursor, PAGE_SIZE);
    const hasMore = rows.length > PAGE_SIZE;
    const items = rows.slice(0, PAGE_SIZE);

    const feedItems: FeedItem[] = items.map((row: any) => {
      const latestVersion = row.versions?.[0] ?? null;
      // Expose AI teaser via cover_image_url (only unused nullable string in contract)
      const packet = (latestVersion?.packetJson as any) ?? {};
      const teaser: string | null = packet.ai_teaser || null;
      return {
        event_id: row.id,
        state: row.state,
        headline: latestVersion?.headline ?? null,
        t_last: row.tLast?.toISOString() ?? null,
        published_at: row.publishedAt?.toISOString() ?? null,
        cover_image_url: teaser,
      };
    });

    let next_cursor: string | null = null;
    if (hasMore && items.length > 0) {
      const last = items[items.length - 1];
      const ts = last.publishedAt?.toISOString() ?? last.createdAt.toISOString();
      next_cursor = Buffer.from(`${ts}|${last.id}`).toString('base64');
    }

    return { items: feedItems, next_cursor };
  }
}
