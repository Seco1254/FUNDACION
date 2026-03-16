import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope, EventHandler } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { FetchHtml, ScraperLookup } from '../domain/types.js';
import { MAX_SNIPPET_CHARS, TEXT_MIN_LEN, MIN_LEN_META } from './constants.js';
import {
  detectPaywall, extractAmpUrl, extractArticleBody,
  extractMetaDescription,
} from '../scrapers/html-utils.js';
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
      const isRssSource = envelope.trace.source_module === 'rss';

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
        // For RSS articles, a parse exception is recoverable via metadata fallback
        if (isRssSource) {
          parsed = { title: '', snippet: '', textContent: '', publishedAt: null };
        } else {
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
      }

      // --- RSS metadata fallback ---
      // Only for articles discovered via RSS: if HTML parse didn't produce
      // a usable title, fall back to RSS feed metadata carried in the event payload.
      // This NEVER activates for non-RSS articles (source_module !== 'rss').
      let usedRssFallback = false;
      if (isRssSource) {
        const payload = envelope.payload as {
          rss_title?: string;
          rss_summary?: string;
          rss_published_at?: string;
        };

        if (!parsed.title || parsed.title.trim().length === 0) {
          if (payload.rss_title && payload.rss_title.trim().length > 0) {
            parsed = {
              ...parsed,
              title: payload.rss_title.trim(),
            };
            usedRssFallback = true;
            logger.info({ url, media_key, fallback_field: 'title' }, 'rss_metadata_fallback_used');
          }
        }

        if ((!parsed.snippet || parsed.snippet.trim().length === 0) && payload.rss_summary) {
          parsed = { ...parsed, snippet: payload.rss_summary.trim() };
          usedRssFallback = true;
        }

        if (!parsed.publishedAt && payload.rss_published_at) {
          const d = new Date(payload.rss_published_at);
          if (!isNaN(d.getTime())) {
            parsed = { ...parsed, publishedAt: d };
            usedRssFallback = true;
          }
        }
      }

      // Policy: block if title is missing or content is empty
      if (!parsed.title || parsed.title.trim().length === 0) {
        logger.info({ url, reason: 'PARSE_FAIL', is_rss: isRssSource }, 'article_missing_title');
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

      // --- Text acquisition ladder ---
      // 1) Body extraction (from scraper's extractArticleBody)
      let bestText = parsed.textContent || '';
      let textContentSource: string = bestText.length > 0 ? 'body' : 'none';

      // 2) AMP fallback: if body text too short, try AMP page
      if (bestText.length < TEXT_MIN_LEN) {
        const ampUrl = extractAmpUrl(html);
        if (ampUrl) {
          try {
            const ampHtml = await this.fetchHtml(ampUrl);
            const ampText = extractArticleBody(ampHtml);
            if (ampText.length > bestText.length) {
              bestText = ampText;
              textContentSource = 'amp';
            }
          } catch {
            // AMP fetch failed, continue with what we have
          }
        }
      }

      // 3) Meta fallback: og:description / description / twitter:description
      if (bestText.length < MIN_LEN_META) {
        const metaText = extractMetaDescription(html);
        if (metaText && metaText.length > bestText.length) {
          bestText = metaText;
          textContentSource = 'meta';
        }
      }

      // 4) RSS summary fallback: only for RSS-sourced articles
      if (isRssSource && bestText.length < MIN_LEN_META) {
        const payload = envelope.payload as { rss_summary?: string };
        if (payload.rss_summary && payload.rss_summary.length > bestText.length) {
          bestText = payload.rss_summary;
          textContentSource = 'rss';
          usedRssFallback = true;
        }
      }

      // 5) None
      if (bestText.length === 0) {
        textContentSource = 'none';
      }

      const textNorm = bestText || null;
      const textContentLen = bestText.length;

      // Paywall detection
      const paywallDetected = detectPaywall(html);

      // Extraction fail reason
      let extractionFailReason: string | null = null;
      if (paywallDetected) extractionFailReason = 'paywall';
      else if (textContentLen === 0) extractionFailReason = 'empty';
      else if (
        ['body', 'amp', 'rss'].includes(textContentSource) && textContentLen < TEXT_MIN_LEN
      ) extractionFailReason = 'too_short';
      else if (textContentSource === 'meta' && textContentLen < MIN_LEN_META) {
        extractionFailReason = 'too_short';
      }

      // Flexible usability threshold
      const usableForOverview = !paywallDetected && (
        (['body', 'amp', 'rss'].includes(textContentSource) && textContentLen >= TEXT_MIN_LEN) ||
        (textContentSource === 'meta' && textContentLen >= MIN_LEN_META)
      );

      // RSS observability
      if (isRssSource) {
        logger.info({
          url,
          media_key,
          used_rss_fallback: usedRssFallback,
          text_content_source: textContentSource,
          text_content_len: textContentLen,
          has_title: !!parsed.title,
          has_snippet: !!snippet,
        }, 'rss_article_entering_pipeline');
      }

      let article;
      try {
        article = await this.articleRepo.create({
          mediaId: media.id,
          url,
          title: parsed.title,
          snippet,
          textNorm,
          textContentLen,
          textContentSource,
          extractionFailReason,
          paywallDetected,
          usableForOverview,
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
