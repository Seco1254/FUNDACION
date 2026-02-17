import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope, EventHandler } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { FetchHtml, ScraperLookup } from '../domain/types.js';
import { MAX_SNIPPET_CHARS } from './constants.js';
import { logger } from '../../../core/logging/logger.js';

export class FetcherParser {
  constructor(
    private articleRepo: ArticleRepository,
    private mediaRepo: MediaRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private fetchHtml: FetchHtml,
    private scraperLookup: ScraperLookup,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { url, media_key } = envelope.payload as { url: string; media_key: string };
      const traceId = envelope.trace.trace_id;

      const media = await this.mediaRepo.findByKey(media_key);
      if (!media) {
        logger.error({ media_key }, 'media_not_found');
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: url,
          action: 'FETCH_FAIL',
          trace_id: traceId,
          data: { url, media_key, error: 'Media not found' },
        });
        return;
      }

      const existing = await this.articleRepo.findByUrl(url);
      if (existing) {
        const blockedEnvelope: EventEnvelope = {
          event_name: 'ArticlePolicyBlocked',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
          payload: { url, reason_code: 'DUPLICATE_URL' },
        };
        await this.eventBus.publish(blockedEnvelope);
        return;
      }

      let html: string;
      try {
        html = await this.fetchHtml(url);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ url, error: error.message }, 'article_fetch_failed');
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: url,
          action: 'FETCH_FAIL',
          trace_id: traceId,
          data: { url, error: error.message },
        });
        const blockedEnvelope: EventEnvelope = {
          event_name: 'ArticlePolicyBlocked',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
          payload: { url, reason_code: 'PARSE_FAIL' },
        };
        await this.eventBus.publish(blockedEnvelope);
        return;
      }

      const scraper = this.scraperLookup(media_key);
      let parsed;
      try {
        parsed = scraper.parseArticle(html, url);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        logger.error({ url, error: error.message }, 'article_parse_failed');
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: url,
          action: 'PARSE_FAIL',
          trace_id: traceId,
          data: { url, error: error.message },
        });
        const blockedEnvelope: EventEnvelope = {
          event_name: 'ArticlePolicyBlocked',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
          payload: { url, reason_code: 'PARSE_FAIL' },
        };
        await this.eventBus.publish(blockedEnvelope);
        return;
      }

      const snippet = parsed.snippet.slice(0, MAX_SNIPPET_CHARS);

      let article;
      try {
        article = await this.articleRepo.create({
          mediaId: media.id,
          url,
          title: parsed.title,
          snippet,
          publishedAt: parsed.publishedAt,
          status: 'NORMALIZED',
        });
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));

        if (error.message.includes('Unique constraint') || error.message.includes('unique')) {
          const blockedEnvelope: EventEnvelope = {
            event_name: 'ArticlePolicyBlocked',
            event_id: ulid(),
            occurred_at: new Date().toISOString(),
            trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
            payload: { url, reason_code: 'DUPLICATE_URL' },
          };
          await this.eventBus.publish(blockedEnvelope);
          return;
        }

        logger.error({ url, error: error.message }, 'article_persist_failed');
        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: url,
          action: 'PARSE_FAIL',
          trace_id: traceId,
          data: { url, error: error.message },
        });
        return;
      }

      const normalizedEnvelope: EventEnvelope = {
        event_name: 'ArticleNormalized',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
        payload: { article_id: article.id },
      };
      await this.eventBus.publish(normalizedEnvelope);
    };
  }
}
