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
import { classifyContent } from '../../text_sanitizer/content-classifier.js';
import { evaluateRoutingDecision } from './content-router.js';
import { cleanDom } from '../../text_sanitizer/dom-cleaner.js';

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

      // Policy: block if title is missing or content is empty
      if (!parsed.title || parsed.title.trim().length === 0) {
        logger.info({ url, reason: 'PARSE_FAIL' }, 'article_missing_title');
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
      // 0) DOM Cleaner: structure-aware HTML cleaning (strips boilerplate
      //    nodes, sidebars, UGC, donation blocks, etc.) before extraction.
      //    Falls through to legacy extraction if result is too short.
      let bestText = '';
      let textContentSource = 'none';

      const domResult = cleanDom({ html, url });
      if (domResult.text.length > 0) {
        bestText = domResult.text;
        textContentSource = 'dom_cleaner_v1';
      }

      // 1) Body extraction (from scraper's extractArticleBody) — legacy fallback
      if (bestText.length < TEXT_MIN_LEN) {
        const bodyText = parsed.textContent || '';
        if (bodyText.length > bestText.length) {
          bestText = bodyText;
          textContentSource = bodyText.length > 0 ? 'body' : 'none';
        }
      }

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

      // 4) None
      if (bestText.length === 0) {
        textContentSource = 'none';
      }

      const textNorm = bestText || null;
      const textContentLen = bestText.length;

      // Paywall detection
      const paywallDetected = detectPaywall(html);

      // Sources that are "body-grade" (full article text, not just meta snippet)
      const isBodyGrade = ['body', 'amp', 'rss', 'dom_cleaner_v1'].includes(textContentSource);

      // Extraction fail reason
      let extractionFailReason: string | null = null;
      if (paywallDetected) extractionFailReason = 'paywall';
      else if (textContentLen === 0) extractionFailReason = 'empty';
      else if (isBodyGrade && textContentLen < TEXT_MIN_LEN) extractionFailReason = 'too_short';
      else if (textContentSource === 'meta' && textContentLen < MIN_LEN_META) {
        extractionFailReason = 'too_short';
      }

      // Flexible usability threshold
      const usableForOverview = !paywallDetected && (
        (isBodyGrade && textContentLen >= TEXT_MIN_LEN) ||
        (textContentSource === 'meta' && textContentLen >= MIN_LEN_META)
      );

      // Content type classification (soft — score + reasons, no exclusion)
      const classification = textNorm
        ? classifyContent({ text: textNorm, title: parsed.title, url })
        : null;
      const contentType = classification?.content_type ?? null;
      const contentTypeScore = classification?.score ?? null;

      // Content-type routing: assign bucket before clustering
      const routingDecision = evaluateRoutingDecision({
        contentType,
        textContentLen,
        title: parsed.title,
        usableForOverview,
      });

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
          contentType,
          contentTypeScore,
          routingDecision,
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
