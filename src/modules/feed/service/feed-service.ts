import { FeedRepository } from '../repo/feed-repo.js';
import { FeedItem, FeedResponse } from '../domain/types.js';
import { RankingService } from '../../ranking/service/ranking-service.js';

const PAGE_SIZE = 20;

export class FeedService {
  private rankingService: RankingService | null;
  private repo: FeedRepository;

  constructor(repo: FeedRepository, rankingService?: RankingService) {
    this.repo = repo;
    this.rankingService = rankingService ?? null;
  }

  async getFeed(cursorStr?: string): Promise<FeedResponse> {
    // When ranking is enabled and this is page 1 (no cursor), use ranked feed
    if (this.rankingService && !cursorStr) {
      return this.getRankedFeed();
    }

    // Fallback: chronological feed (also used for pagination after page 1)
    return this.getChronologicalFeed(cursorStr);
  }

  private async getRankedFeed(): Promise<FeedResponse> {
    // Fetch a larger window for ranking (top 60 events, rank, return top 20)
    const RANK_WINDOW = 60;
    const rows = await this.repo.getFeed(undefined, RANK_WINDOW);

    if (rows.length === 0) {
      return { items: [], next_cursor: null };
    }

    const scored = await this.rankingService!.rankPublishedEvents(rows as any);

    // Map scored results back to rows
    const rowMap = new Map(rows.map((r: any) => [r.id, r]));
    const rankedRows = scored
      .map((s) => rowMap.get(s.eventId))
      .filter((r): r is NonNullable<typeof r> => r != null);

    const items = rankedRows.slice(0, PAGE_SIZE);

    const feedItems: FeedItem[] = items.map((row: any) => {
      const latestVersion = row.versions?.[0] ?? null;
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

    // Cursor for page 2+: fall back to chronological after ranked page 1
    let next_cursor: string | null = null;
    if (rankedRows.length > PAGE_SIZE) {
      const last = items[items.length - 1] as any;
      const ts = last.publishedAt?.toISOString() ?? last.createdAt.toISOString();
      next_cursor = Buffer.from(`${ts}|${last.id}`).toString('base64');
    }

    return { items: feedItems, next_cursor };
  }

  private async getChronologicalFeed(cursorStr?: string): Promise<FeedResponse> {
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
