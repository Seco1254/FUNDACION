import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { FetchHtml, ScraperLookup } from '../domain/types.js';
import { logger } from '../../../core/logging/logger.js';
import { withTimeout } from '../../../core/async/with-timeout.js';

const PER_MEDIA_TIMEOUT_MS = parseInt(process.env.PER_MEDIA_TIMEOUT_MS ?? '20000', 10);

export interface MediaScrapeResult {
  media_key: string;
  ok: boolean;
  discovered: number;
  skipped: number;
  fetch_fail: number;
  duration_ms: number;
  error?: string;
}

export class ScrapeOrchestrator {
  constructor(
    private mediaRepo: MediaRepository,
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private fetchHtml: FetchHtml,
    private scraperLookup: ScraperLookup,
  ) {}

  async run(): Promise<{
    discovered: number;
    skipped: number;
    summary: Record<string, { discovered: number; skipped: number; fetch_fail: number }>;
    media_results: MediaScrapeResult[];
  }> {
    const traceId = ulid();
    const media = await this.mediaRepo.findAllAllowlisted();
    let discovered = 0;
    let skipped = 0;
    const seenUrls = new Set<string>();
    const summary: Record<string, { discovered: number; skipped: number; fetch_fail: number }> = {};
    const mediaResults: MediaScrapeResult[] = [];

    for (const m of media) {
      const scraper = this.scraperLookup(m.mediaKey);

      if (scraper.listPageUrls.length === 0) continue;

      const mediaStart = Date.now();
      const mediaStats = { discovered: 0, skipped: 0, fetch_fail: 0 };

      try {
        await withTimeout(
          this.processMedia(m.mediaKey, scraper, seenUrls, mediaStats, traceId),
          PER_MEDIA_TIMEOUT_MS,
          { stage: 'media_scrape', mediaKey: m.mediaKey },
        );

        mediaResults.push({
          media_key: m.mediaKey,
          ok: true,
          discovered: mediaStats.discovered,
          skipped: mediaStats.skipped,
          fetch_fail: mediaStats.fetch_fail,
          duration_ms: Date.now() - mediaStart,
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ mediaKey: m.mediaKey, error: error.message, duration_ms: Date.now() - mediaStart }, 'scrape_media_timeout_or_error');

        mediaResults.push({
          media_key: m.mediaKey,
          ok: false,
          discovered: mediaStats.discovered,
          skipped: mediaStats.skipped,
          fetch_fail: mediaStats.fetch_fail,
          duration_ms: Date.now() - mediaStart,
          error: error.message,
        });
      }

      discovered += mediaStats.discovered;
      skipped += mediaStats.skipped;
      summary[m.mediaKey] = { ...mediaStats };
    }

    // Log per-media scrape summary
    for (const [key, stats] of Object.entries(summary)) {
      logger.info(
        { mediaKey: key, discovered: stats.discovered, skipped: stats.skipped, fetch_fail: stats.fetch_fail },
        'scrape_media_summary',
      );
    }
    logger.info({ total_discovered: discovered, total_skipped: skipped, media_count: Object.keys(summary).length }, 'scrape_run_complete');

    return { discovered, skipped, summary, media_results: mediaResults };
  }

  private async processMedia(
    mediaKey: string,
    scraper: { listPageUrls: string[]; extractUrls: (html: string) => string[] },
    seenUrls: Set<string>,
    stats: { discovered: number; skipped: number; fetch_fail: number },
    traceId: string,
  ): Promise<void> {
    for (const listUrl of scraper.listPageUrls) {
      let html: string;
      try {
        html = await this.fetchHtml(listUrl);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ mediaKey, listUrl, error: error.message }, 'list_page_fetch_failed');
        stats.fetch_fail++;
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: mediaKey,
          action: 'SCRAPE_FAIL',
          trace_id: traceId,
          data: { mediaKey, listUrl, error: error.message },
        });
        continue;
      }

      const urls = scraper.extractUrls(html);

      for (const url of urls) {
        if (seenUrls.has(url)) {
          stats.skipped++;
          continue;
        }
        seenUrls.add(url);

        const existing = await this.articleRepo.findByUrl(url);
        if (existing) {
          stats.skipped++;
          continue;
        }

        const envelope: EventEnvelope = {
          event_name: 'ArticleDiscovered',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: {
            trace_id: traceId,
            span_id: ulid(),
            source_module: 'ingestion',
          },
          payload: {
            url,
            media_key: mediaKey,
            discovered_at: new Date().toISOString(),
          },
        };

        await this.eventBus.publish(envelope);
        stats.discovered++;
      }
    }
  }
}
