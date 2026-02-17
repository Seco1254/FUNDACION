import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { FetchHtml, ScraperLookup } from '../domain/types.js';
import { logger } from '../../../core/logging/logger.js';

export class ScrapeOrchestrator {
  constructor(
    private mediaRepo: MediaRepository,
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private fetchHtml: FetchHtml,
    private scraperLookup: ScraperLookup,
  ) {}

  async run(): Promise<{ discovered: number; skipped: number }> {
    const traceId = ulid();
    const media = await this.mediaRepo.findAllAllowlisted();
    let discovered = 0;
    let skipped = 0;
    const seenUrls = new Set<string>();

    for (const m of media) {
      const scraper = this.scraperLookup(m.mediaKey);

      if (scraper.listPageUrls.length === 0) continue;

      for (const listUrl of scraper.listPageUrls) {
        let html: string;
        try {
          html = await this.fetchHtml(listUrl);
        } catch (err) {
          const error = err instanceof Error ? err : new Error(String(err));
          logger.error({ mediaKey: m.mediaKey, listUrl, error: error.message }, 'list_page_fetch_failed');
          await this.auditWriter.write({
            entity_type: 'ARTICLE',
            entity_id: m.mediaKey,
            action: 'SCRAPE_FAIL',
            trace_id: traceId,
            data: { mediaKey: m.mediaKey, listUrl, error: error.message },
          });
          continue;
        }

        const urls = scraper.extractUrls(html);

        for (const url of urls) {
          if (seenUrls.has(url)) {
            skipped++;
            continue;
          }
          seenUrls.add(url);

          const existing = await this.articleRepo.findByUrl(url);
          if (existing) {
            skipped++;
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
              media_key: m.mediaKey,
              discovered_at: new Date().toISOString(),
            },
          };

          await this.eventBus.publish(envelope);
          discovered++;
        }
      }
    }

    return { discovered, skipped };
  }
}
