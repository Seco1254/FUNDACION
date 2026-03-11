import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { computeEmbedding, computeEmbeddingHash, textForEmbedding, MODEL_NAME } from './hash-vector.js';
import { logger } from '../../../core/logging/logger.js';
import { sanitizeText } from '../../text_sanitizer/sanitize.js';

export class EmbeddingService {
  constructor(
    private articleRepo: ArticleRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { article_id } = envelope.payload as { article_id: string };
      const traceId = envelope.trace.trace_id;

      const article = await this.articleRepo.findById(article_id);
      if (!article) {
        logger.error({ article_id }, 'article_not_found_for_embedding');
        return;
      }

      const rawText = textForEmbedding(article.title, article.snippet);
      const { cleaned_text } = sanitizeText({
        text: rawText,
        source: { media_key: undefined, url: article.url },
      });
      const text = cleaned_text;
      const hash = computeEmbeddingHash(text);

      if (article.embeddingHash === hash) {
        logger.info({ article_id }, 'embedding_already_current');
        await this.eventBus.publish({
          event_name: 'ArticleEmbedded',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'embedding' },
          payload: { article_id },
        });
        return;
      }

      const vec = computeEmbedding(text);

      await this.articleRepo.updateEmbedding(article_id, {
        embeddingModel: MODEL_NAME,
        embeddingHash: hash,
        embeddingVec: vec,
      });

      await this.eventBus.publish({
        event_name: 'ArticleEmbedded',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'embedding' },
        payload: { article_id },
      });
    };
  }
}
