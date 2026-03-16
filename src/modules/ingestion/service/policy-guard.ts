import { ulid } from 'ulid';
import { EventBus } from '../../../core/event_bus/index.js';
import { EventEnvelope, EventHandler } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { MIN_SNIPPET_CHARS } from './constants.js';
import { isSpanish } from './language-detector.js';
import { classifyGeoRelevance, isGeoFilterEnabled } from './geo-relevance.js';
import { RSS_FEEDS } from '../rss/feeds.js';
import { metrics } from '../../../core/metrics/metrics.js';
import { logger } from '../../../core/logging/logger.js';

export class PolicyGuard {
  constructor(
    private articleRepo: ArticleRepository,
    private mediaRepo: MediaRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { article_id } = envelope.payload as { article_id: string };
      const traceId = envelope.trace.trace_id;

      const article = await this.articleRepo.findById(article_id);
      if (!article) {
        logger.error({ article_id }, 'article_not_found_for_policy');
        return;
      }

      const media = await this.mediaRepo.findById(article.mediaId);

      if (!media || !media.allowlisted) {
        await this.block(article.id, article.url, 'NOT_ALLOWLISTED', traceId, media?.mediaKey);
        return;
      }

      if (!article.snippet || article.snippet.trim().length < MIN_SNIPPET_CHARS) {
        await this.block(article.id, article.url, 'NO_EXTRACT', traceId, media.mediaKey);
        return;
      }

      if (!isSpanish(article.snippet)) {
        await this.block(article.id, article.url, 'NOT_SPANISH', traceId, media.mediaKey);
        return;
      }

      // Geographic relevance filter (opt-in per media via geoFilter flag in feed registry)
      const feedEntry = RSS_FEEDS.find((f) => f.mediaKey === media.mediaKey);
      if (feedEntry?.geoFilter && isGeoFilterEnabled()) {
        const geoResult = classifyGeoRelevance(
          article.title ?? '',
          article.snippet ?? '',
        );

        logger.info({
          url: article.url,
          media_key: media.mediaKey,
          tier: geoResult.tier,
          matched_keywords: geoResult.matchedKeywords,
        }, 'geo_relevance_classified');
        metrics.incCounter(`article.geo_relevance.${geoResult.tier}.total`);
        metrics.incCounter(`article.geo_relevance.by_media.${media.mediaKey}.${geoResult.tier}.total`);

        if (geoResult.tier === 'international') {
          await this.block(article.id, article.url, 'NOT_RELEVANT_GEO', traceId, media.mediaKey);
          return;
        }
      }

      await this.articleRepo.updateStatus(article.id, 'POLICY_OK');

      const okEnvelope: EventEnvelope = {
        event_name: 'ArticlePolicyOk',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
        payload: { article_id: article.id },
      };
      await this.eventBus.publish(okEnvelope);
    };
  }

  private async block(
    articleId: string,
    url: string,
    reasonCode: string,
    traceId: string,
    mediaKey?: string,
  ): Promise<void> {
    await this.articleRepo.updateStatus(articleId, 'POLICY_BLOCKED', reasonCode);

    const blockedEnvelope: EventEnvelope = {
      event_name: 'ArticlePolicyBlocked',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'ingestion' },
      payload: { url, reason_code: reasonCode, media_key: mediaKey ?? 'unknown' },
    };
    await this.eventBus.publish(blockedEnvelope);

    await this.auditWriter.write({
      entity_type: 'ARTICLE',
      entity_id: articleId,
      action: 'POLICY_FAIL',
      trace_id: traceId,
      data: { url, reason_code: reasonCode },
    });
  }
}
