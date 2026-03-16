/**
 * RSS Discovery Job — reads RSS feeds, normalizes items, deduplicates,
 * and emits ArticleDiscovered events into the existing pipeline.
 *
 * This module is discovery-only: it discovers URLs and metadata from RSS feeds.
 * The existing pipeline (FetcherParser → PolicyGuard → Embedding → Linker)
 * handles the actual article processing.
 */

import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { RssFeedEntry, getEnabledFeeds } from './feeds.js';
import { fetchRssFeed } from './rss-fetcher.js';
import { parseRssXml } from './rss-parser.js';
import { normalizeRssItem, isEnglishMirror, RssDiscoveredItem } from './rss-normalizer.js';
import { isSpanish } from '../service/language-detector.js';

export interface RssDiscoveryResult {
  feedsProcessed: number;
  feedsFailed: number;
  itemsSeen: number;
  itemsNew: number;
  itemsDuplicate: number;
  byMedia: Record<string, { seen: number; new: number; duplicate: number }>;
  errors: Array<{ mediaKey: string; error: string }>;
  durationMs: number;
}

export type FetchRssFn = (url: string) => Promise<{ xml: string; latencyMs: number }>;

export class RssDiscoveryJob {
  private seenIdentityKeys = new Set<string>();

  constructor(
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private fetchFn: FetchRssFn = fetchRssFeed,
  ) {}

  async run(feeds?: RssFeedEntry[]): Promise<RssDiscoveryResult> {
    const start = Date.now();
    const traceId = `rss-${ulid()}`;
    const feedList = feeds ?? getEnabledFeeds();

    logger.info({
      trace_id: traceId,
      feed_count: feedList.length,
      feeds: feedList.map((f) => f.mediaKey),
    }, 'rss_discovery_start');

    const result: RssDiscoveryResult = {
      feedsProcessed: 0,
      feedsFailed: 0,
      itemsSeen: 0,
      itemsNew: 0,
      itemsDuplicate: 0,
      byMedia: {},
      errors: [],
      durationMs: 0,
    };

    for (const feed of feedList) {
      const mediaStats = { seen: 0, new: 0, duplicate: 0 };
      result.byMedia[feed.mediaKey] = mediaStats;

      try {
        const items = await this.processFeed(feed, traceId, mediaStats);
        result.feedsProcessed++;
        result.itemsSeen += mediaStats.seen;
        result.itemsNew += mediaStats.new;
        result.itemsDuplicate += mediaStats.duplicate;

        metrics.incCounter(`rss.by_media.${feed.mediaKey}`);
        logger.info({
          trace_id: traceId,
          media_key: feed.mediaKey,
          seen: mediaStats.seen,
          new_items: mediaStats.new,
          duplicate: mediaStats.duplicate,
        }, 'rss_feed_processed');
      } catch (err) {
        result.feedsFailed++;
        const error = err instanceof Error ? err : new Error(String(err));
        result.errors.push({ mediaKey: feed.mediaKey, error: error.message });

        logger.error({
          trace_id: traceId,
          media_key: feed.mediaKey,
          error: error.message,
        }, 'rss_feed_failed');
      }
    }

    result.durationMs = Date.now() - start;

    // Aggregate metrics (last-run snapshot)
    metrics.setGauge('rss.last_run_items_seen', result.itemsSeen);
    metrics.setGauge('rss.last_run_items_new', result.itemsNew);
    metrics.setGauge('rss.last_run_items_duplicate', result.itemsDuplicate);
    metrics.setGauge('rss.last_run_duration_ms', result.durationMs);

    logger.info({
      trace_id: traceId,
      feeds_processed: result.feedsProcessed,
      feeds_failed: result.feedsFailed,
      items_seen: result.itemsSeen,
      items_new: result.itemsNew,
      items_duplicate: result.itemsDuplicate,
      duration_ms: result.durationMs,
    }, 'rss_discovery_complete');

    return result;
  }

  private async processFeed(
    feed: RssFeedEntry,
    traceId: string,
    stats: { seen: number; new: number; duplicate: number },
  ): Promise<RssDiscoveredItem[]> {
    const { xml } = await this.fetchFn(feed.feedUrl);
    const parsed = parseRssXml(xml);

    const newItems: RssDiscoveredItem[] = [];

    for (const rawItem of parsed.items) {
      // Skip English mirror URLs (e.g., El Turbión /en/ articles)
      if (rawItem.link && isEnglishMirror(rawItem.link, feed.mediaKey)) {
        metrics.incCounter('rss.en_mirror_skipped_total');
        logger.info({ url: rawItem.link, media_key: feed.mediaKey }, 'rss_en_mirror_skipped');
        continue;
      }

      // Early language filter for bilingual sources (El Turbión publishes ES + EN)
      if (feed.mediaKey === 'el_turbion') {
        const rawText = `${rawItem.title ?? ''} ${rawItem.description ?? ''}`;
        if (rawText.trim().length > 0 && !isSpanish(rawText)) {
          metrics.incCounter('rss.filtered_not_spanish.total');
          logger.info({ url: rawItem.link, media_key: feed.mediaKey }, 'rss_filtered_not_spanish');
          continue;
        }
      }

      const normalized = normalizeRssItem(rawItem, feed.mediaKey, feed.feedUrl);
      if (!normalized) continue;

      stats.seen++;
      metrics.incCounter('rss.items_seen_total');

      // Dedupe layer 1: in-memory identity key (within this run)
      if (this.seenIdentityKeys.has(normalized.identityKey)) {
        stats.duplicate++;
        metrics.incCounter('rss.items_duplicate_total');
        continue;
      }
      this.seenIdentityKeys.add(normalized.identityKey);

      // Dedupe layer 2: canonical URL already in DB
      const existing = await this.articleRepo.findByUrl(normalized.url);
      if (existing) {
        stats.duplicate++;
        metrics.incCounter('rss.items_duplicate_total');
        continue;
      }

      // New discovery — emit ArticleDiscovered into the pipeline
      stats.new++;
      metrics.incCounter('rss.items_new_total');

      const envelope: EventEnvelope = {
        event_name: 'ArticleDiscovered',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: {
          trace_id: traceId,
          span_id: ulid(),
          source_module: 'rss',
        },
        payload: {
          url: normalized.url,
          media_key: feed.mediaKey,
          discovered_at: new Date().toISOString(),
          // RSS metadata for downstream fallback (used only when HTML parse fails)
          rss_title: normalized.title || undefined,
          rss_summary: normalized.summary || undefined,
          rss_published_at: normalized.publishedAt?.toISOString() || undefined,
        },
      };

      try {
        await this.eventBus.publish(envelope);
      } catch (pipelineErr) {
        const error = pipelineErr instanceof Error ? pipelineErr : new Error(String(pipelineErr));
        logger.error({
          error: error.message,
          url: normalized.url,
          media_key: feed.mediaKey,
        }, 'rss_article_pipeline_error');
      }

      newItems.push(normalized);
    }

    return newItems;
  }

  /** Reset in-memory dedup state (useful for testing). */
  resetDedup(): void {
    this.seenIdentityKeys.clear();
  }
}
