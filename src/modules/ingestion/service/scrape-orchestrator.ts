import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { FetchHtml, ScraperLookup, MediaScraper } from '../domain/types.js';
import { logger } from '../../../core/logging/logger.js';

export interface ScrapeProgress {
  media_key: string | null;
  stage: string;
  url?: string | null;
}

type MediaStats = { discovered: number; skipped: number; fetch_fail: number };

export class ScrapeOrchestrator {
  constructor(
    private mediaRepo: MediaRepository,
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private fetchHtml: FetchHtml,
    private scraperLookup: ScraperLookup,
  ) {}

  async run(
    onProgress?: (p: ScrapeProgress) => void,
  ): Promise<{ discovered: number; skipped: number; summary: Record<string, MediaStats> }> {
    const traceId = ulid();
    const summary: Record<string, MediaStats> = {};

    // Read per-media timeout dynamically so tests can override via env.
    const mediaTimeoutMs = parseInt(process.env.SCRAPE_MEDIA_TIMEOUT_MS ?? '25000', 10);

    onProgress?.({ media_key: null, stage: 'orchestrator_start' });
    logger.info({ trace_id: traceId }, 'orchestrator_start');

    const media = await this.mediaRepo.findAllAllowlisted();
    onProgress?.({ media_key: null, stage: 'media_list_end' });

    const seenUrls = new Set<string>();

    for (const m of media) {
      const scraper = this.scraperLookup(m.mediaKey);
      if (scraper.listPageUrls.length === 0) continue;

      summary[m.mediaKey] = { discovered: 0, skipped: 0, fetch_fail: 0 };
      onProgress?.({ media_key: m.mediaKey, stage: 'media_run_start' });
      logger.info({ trace_id: traceId, media_key: m.mediaKey }, 'media_run_start');

      // Cooperative cancellation: signal is checked at each iteration boundary in _runMedia.
      // This prevents a single slow medium from blocking the rest of the run.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), mediaTimeoutMs);

      try {
        await this._runMedia(
          m, scraper, seenUrls, summary[m.mediaKey], traceId, controller.signal, onProgress,
        );
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ trace_id: traceId, media_key: m.mediaKey, error: error.message }, 'media_error');
        summary[m.mediaKey].fetch_fail++;
        onProgress?.({ media_key: m.mediaKey, stage: 'media_error' });
      } finally {
        clearTimeout(timeoutId);
      }

      if (controller.signal.aborted) {
        logger.warn(
          { trace_id: traceId, media_key: m.mediaKey, timeout_ms: mediaTimeoutMs },
          'media_timeout',
        );
        if (summary[m.mediaKey].fetch_fail === 0) summary[m.mediaKey].fetch_fail++;
        onProgress?.({ media_key: m.mediaKey, stage: 'media_timeout' });
      }

      onProgress?.({ media_key: m.mediaKey, stage: 'media_run_end' });
      logger.info(
        {
          trace_id: traceId,
          media_key: m.mediaKey,
          discovered: summary[m.mediaKey].discovered,
          skipped: summary[m.mediaKey].skipped,
          fetch_fail: summary[m.mediaKey].fetch_fail,
        },
        'scrape_media_summary',
      );
    }

    let discovered = 0;
    let skipped = 0;
    for (const stats of Object.values(summary)) {
      discovered += stats.discovered;
      skipped += stats.skipped;
    }

    logger.info(
      { trace_id: traceId, total_discovered: discovered, total_skipped: skipped, media_count: Object.keys(summary).length },
      'scrape_run_complete',
    );
    onProgress?.({ media_key: null, stage: 'orchestrator_end' });

    return { discovered, skipped, summary };
  }

  private async _runMedia(
    m: { id: string; mediaKey: string },
    scraper: MediaScraper,
    seenUrls: Set<string>,
    stats: MediaStats,
    traceId: string,
    signal: AbortSignal,
    onProgress?: (p: ScrapeProgress) => void,
  ): Promise<void> {
    for (const listUrl of scraper.listPageUrls) {
      if (signal.aborted) break;

      onProgress?.({ media_key: m.mediaKey, stage: 'fetch_start', url: listUrl });
      logger.info({ trace_id: traceId, media_key: m.mediaKey, url: listUrl }, 'fetch_start');

      let html: string;
      try {
        html = await this.fetchHtml(listUrl);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ media_key: m.mediaKey, url: listUrl, error: error.message }, 'list_page_fetch_failed');
        stats.fetch_fail++;
        onProgress?.({ media_key: m.mediaKey, stage: 'fetch_fail', url: listUrl });
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: m.mediaKey,
          action: 'SCRAPE_FAIL',
          trace_id: traceId,
          data: { mediaKey: m.mediaKey, listUrl, error: error.message },
        });
        continue;
      }

      if (signal.aborted) break;

      onProgress?.({ media_key: m.mediaKey, stage: 'parse_start', url: listUrl });
      const urls = scraper.extractUrls(html);
      onProgress?.({ media_key: m.mediaKey, stage: 'parse_end', url: listUrl });

      for (const url of urls) {
        if (signal.aborted) break;

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

        if (signal.aborted) break;

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
            media_key: m.mediaKey,
            discovered_at: new Date().toISOString(),
          },
        };

        try {
          await this.eventBus.publish(envelope);
        } catch (pipelineErr) {
          const error = pipelineErr instanceof Error ? pipelineErr : new Error(String(pipelineErr));
          logger.error(
            { error: error.message, url, media_key: m.mediaKey },
            'article_pipeline_error',
          );
        }
        // Count as discovered regardless of pipeline result — the URL was new.
        stats.discovered++;
      }
    }
  }
}
