import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { buildFeedItem } from '../../modules/feed/service/feed-service.js';
import { Cache } from '../../core/cache/cache.js';
import { PRODUCT_TOPIC_KEYS } from '../../contracts/product/shared.js';
import type { SearchResultItem, SearchResponse } from '../../contracts/product/search.js';
import type { FeedCard } from '../../contracts/product/feed-card.js';

const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 100;

function isValidCursor(cursorStr: string): boolean {
  try {
    const decoded = Buffer.from(cursorStr, 'base64').toString('utf-8');
    const pipeIdx = decoded.indexOf('|');
    if (pipeIdx < 1) return false;
    const datePart = decoded.slice(0, pipeIdx);
    const idPart = decoded.slice(pipeIdx + 1);
    if (!idPart || idPart.length === 0) return false;
    const d = new Date(datePart);
    if (isNaN(d.getTime())) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Build match_headline: wrap query matches in <mark> tags.
 */
function buildMatchHeadline(headline: string, query: string): string | null {
  if (!query || !headline) return null;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  if (!re.test(headline)) return null;
  return headline.replace(re, '<mark>$1</mark>');
}

/**
 * Transform a FeedCard into a SearchResultItem.
 * Summary resolution: what_happened[0] → headline → null
 */
function toSearchResultItem(item: FeedCard, query: string): SearchResultItem {
  let summary: string | null = null;
  if (item.overview.status === 'ready' && item.overview.what_happened.length > 0) {
    summary = item.overview.what_happened[0];
  } else if (item.headline) {
    summary = item.headline;
  }

  return {
    event_id: item.event_id,
    headline: item.headline,
    published_at: item.published_at,
    updated_at: item.updated_at,
    summary,
    confidence_label: item.overview.confidence_label,
    topic: item.topic,
    sources: item.sources,
    source_count: item.source_count,
    article_count: item.article_count,
    evidence_level: item.evidence_level,
    cover_image_url: item.cover_image_url,
    match_headline: buildMatchHeadline(item.headline, query),
  };
}

export function searchRoutes(eventRepo: EventRepository, cache?: Cache) {
  return async function (app: FastifyInstance) {
    app.get<{ Querystring: { q?: string; limit?: string; cursor?: string; topic?: string } }>(
      '/v1/search',
      async (request, reply) => {
        const q = (request.query.q ?? '').trim();

        if (q.length < MIN_QUERY_LEN) {
          return reply.status(400).send({
            error: 'Invalid query',
            message: `Query parameter "q" must be at least ${MIN_QUERY_LEN} characters.`,
          });
        }

        if (q.length > MAX_QUERY_LEN) {
          return reply.status(400).send({
            error: 'Invalid query',
            message: `Query parameter "q" must be at most ${MAX_QUERY_LEN} characters.`,
          });
        }

        const limit = Math.min(
          Math.max(1, parseInt(request.query.limit ?? String(DEFAULT_LIMIT), 10) || DEFAULT_LIMIT),
          MAX_LIMIT,
        );

        const cursorStr = request.query.cursor;
        if (cursorStr !== undefined && cursorStr !== '') {
          if (!isValidCursor(cursorStr)) {
            return reply.status(400).send({
              error: 'Invalid cursor',
              message: 'The cursor parameter is malformed. Use the next_cursor value from a previous response.',
            });
          }
        }

        const topic = request.query.topic;
        if (topic !== undefined && topic !== '') {
          if (!PRODUCT_TOPIC_KEYS.has(topic)) {
            return reply.status(400).send({
              error: 'Invalid topic',
              message: `Topic "${topic}" is not a valid product topic key.`,
            });
          }
        }

        const topicFilter = topic && PRODUCT_TOPIC_KEYS.has(topic) ? topic : undefined;

        // Parse cursor
        let cursor: { publishedAt: Date; eventId: string } | undefined;
        if (cursorStr) {
          const decoded = Buffer.from(cursorStr, 'base64').toString('utf-8');
          const [publishedAtStr, eventId] = decoded.split('|');
          if (publishedAtStr && eventId) {
            cursor = { publishedAt: new Date(publishedAtStr), eventId };
          }
        }

        const cacheKey = `search:${q.toLowerCase()}:${limit}:${cursorStr ?? ''}:${topicFilter ?? ''}`;

        if (cache) {
          const cached = cache.get(cacheKey);
          if (cached !== undefined) return cached;
        }

        const rows = await eventRepo.searchPublished(q, limit, cursor, topicFilter);

        const allItems = rows.map((row: any) => buildFeedItem(row));
        const eligible = allItems.filter((r) => r.eligible);

        const hasMore = eligible.length > limit;
        const pageItems = eligible.slice(0, limit);

        let next_cursor: string | null = null;
        if (hasMore && pageItems.length > 0) {
          const lastItem = pageItems[pageItems.length - 1].item;
          const lastRow = rows.find((r: any) => r.id === lastItem.event_id) ?? rows[rows.length - 1];
          const ts = lastRow?.publishedAt?.toISOString() ?? lastRow?.createdAt?.toISOString() ?? new Date().toISOString();
          next_cursor = Buffer.from(`${ts}|${lastItem.event_id}`).toString('base64');
        }

        const results: SearchResultItem[] = pageItems.map((r) => toSearchResultItem(r.item, q));

        const body: SearchResponse = {
          items: results,
          query: q,
          next_cursor,
          meta: { has_more: hasMore },
        };

        if (cache) {
          cache.set(cacheKey, body, 15_000);
        }

        reply.header('cache-control', 'public, max-age=15');
        return body;
      },
    );
  };
}
