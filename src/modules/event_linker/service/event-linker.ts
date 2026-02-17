import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { Clock } from '../../../core/time/clock.js';
import { cosineSimilarity, computeCentroid, THETA_JOIN, THETA_MERGE } from './similarity.js';
import { logger } from '../../../core/logging/logger.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export class EventLinker {
  constructor(
    private articleRepo: ArticleRepository,
    private eventRepo: EventRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private clock: Clock,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { article_id } = envelope.payload as { article_id: string };
      const traceId = envelope.trace.trace_id;

      const article = await this.articleRepo.findById(article_id);
      if (!article || !article.embeddingVec) {
        logger.error({ article_id }, 'article_missing_embedding');
        return;
      }

      const articleVec = article.embeddingVec;
      const now = this.clock.now();
      const since = new Date(now.getTime() - SEVEN_DAYS_MS);
      const candidates = await this.eventRepo.findCandidateEvents(since);

      let bestScore = -1;
      let bestEventId: string | null = null;
      const scores: Record<string, number> = {};

      for (const candidate of candidates) {
        const articles = await this.eventRepo.findArticlesForEvent(candidate.id);
        const vecs = articles
          .filter((a: any) => a.embeddingVec)
          .map((a: any) => a.embeddingVec as number[]);

        if (vecs.length === 0) continue;

        const centroid = computeCentroid(vecs);
        const score = cosineSimilarity(articleVec, centroid);
        scores[candidate.id] = score;

        if (score > bestScore) {
          bestScore = score;
          bestEventId = candidate.id;
        }
      }

      if (bestScore >= THETA_JOIN && bestEventId) {
        await this.eventRepo.linkArticle(bestEventId, article_id);

        await this.auditWriter.write({
          entity_type: 'ARTICLE',
          entity_id: article_id,
          action: 'LINKED_EXISTING',
          trace_id: traceId,
          data: { event_id: bestEventId, score: bestScore, scores, threshold: THETA_JOIN },
        });

        await this.eventBus.publish({
          event_name: 'ArticleLinkedToEvent',
          event_id: ulid(),
          occurred_at: now.toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker' },
          payload: { article_id, event_id: bestEventId, link_action: 'LINKED_EXISTING' },
        });
      } else {
        const event = await this.eventRepo.create({
          state: 'DETECTED',
          t0: now,
          tLast: now,
        });

        await this.eventRepo.linkArticle(event.id, article_id);

        await this.auditWriter.write({
          entity_type: 'EVENT',
          entity_id: event.id,
          action: 'CREATED_EVENT',
          trace_id: traceId,
          data: { seed_article_id: article_id, best_score: bestScore, scores, threshold: THETA_JOIN },
        });

        await this.eventBus.publish({
          event_name: 'EventCreated',
          event_id: ulid(),
          occurred_at: now.toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker' },
          payload: { event_id: event.id, seed_article_id: article_id },
        });

        await this.eventBus.publish({
          event_name: 'ArticleLinkedToEvent',
          event_id: ulid(),
          occurred_at: now.toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker' },
          payload: { article_id, event_id: event.id, link_action: 'TRIGGER_CREATE' },
        });

        await this.mergeCheck(event.id, articleVec, candidates, traceId);
      }
    };
  }

  private async mergeCheck(
    newEventId: string,
    newVec: number[],
    candidates: Array<{ id: string; t0: Date | null }>,
    traceId: string,
  ): Promise<void> {
    for (const candidate of candidates) {
      const articles = await this.eventRepo.findArticlesForEvent(candidate.id);
      const vecs = articles
        .filter((a: any) => a.embeddingVec)
        .map((a: any) => a.embeddingVec as number[]);

      if (vecs.length === 0) continue;

      const centroid = computeCentroid(vecs);
      const score = cosineSimilarity(newVec, centroid);

      if (score >= THETA_MERGE) {
        const newCount = await this.eventRepo.countArticlesForEvent(newEventId);
        const existingCount = await this.eventRepo.countArticlesForEvent(candidate.id);

        let canonicalId: string;
        let mergedId: string;

        if (existingCount > newCount) {
          canonicalId = candidate.id;
          mergedId = newEventId;
        } else if (newCount > existingCount) {
          canonicalId = newEventId;
          mergedId = candidate.id;
        } else {
          const newEvent = await this.eventRepo.findById(newEventId);
          const newT0 = newEvent?.t0?.getTime() ?? Infinity;
          const candidateT0 = candidate.t0?.getTime() ?? Infinity;
          canonicalId = candidateT0 <= newT0 ? candidate.id : newEventId;
          mergedId = canonicalId === newEventId ? candidate.id : newEventId;
        }

        await this.eventRepo.update(mergedId, { canonicalEventId: canonicalId });

        await this.auditWriter.write({
          entity_type: 'MERGE',
          entity_id: mergedId,
          action: 'MERGED_EVENT',
          trace_id: traceId,
          data: { from_event_id: mergedId, to_event_id: canonicalId, score, threshold: THETA_MERGE },
        });

        await this.eventBus.publish({
          event_name: 'MergeExecuted',
          event_id: ulid(),
          occurred_at: this.clock.now().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker' },
          payload: { from_event_id: mergedId, to_event_id: canonicalId, canonical_event_id: canonicalId },
        });

        break;
      }
    }
  }
}
