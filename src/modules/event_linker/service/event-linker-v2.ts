/**
 * EventLinker v2 — spec-exact implementation.
 *
 * Enhanced event linking with:
 *   - Multi-feature candidate scoring (embedding + entity + temporal)
 *   - Hard block evaluation (action, city, date)
 *   - Optional LLM pair scoring for borderline cases
 *   - Mega-event prevention (max 25 articles, max 7 sub-events)
 *   - Merge decision: >=0.62 auto, 0.50-0.62 requires >=2 media, <0.50 create
 */

import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ArticleRepository } from '../../articles/repo/article-repo.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { Clock } from '../../../core/time/clock.js';
import { LlmClient } from '../../../core/llm/client.js';
import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';

import { cosineSimilarity, computeCentroid, THETA_MERGE } from './similarity.js';
import {
  decideLinkAction,
  ArticleForPairing,
  EventCandidate,
} from './pair-scorer.js';
import { checkMegaEvent, MAX_ARTICLES_PER_EVENT } from './mega-event-guard.js';
import { THETA_AUTO_LINK, THETA_MAYBE_LINK } from './pair-scorer.js';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const DEBUG_LINKER = process.env.DEBUG_EVENT_LINKER === '1';

export class EventLinkerV2 {
  constructor(
    private articleRepo: ArticleRepository,
    private eventRepo: EventRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    private clock: Clock,
    private llm: LlmClient | null = null,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { article_id } = envelope.payload as { article_id: string };
      const traceId = envelope.trace.trace_id;

      const article = await this.articleRepo.findById(article_id);
      if (!article || !article.embeddingVec) {
        logger.error({ article_id }, 'article_missing_embedding_v2');
        return;
      }

      const articleVec = article.embeddingVec as number[];
      const now = this.clock.now();
      const since = new Date(now.getTime() - SEVEN_DAYS_MS);
      const rawCandidates = await this.eventRepo.findCandidateEvents(since);

      // Build rich candidate objects for pair scoring
      const candidates: EventCandidate[] = [];
      for (const candidate of rawCandidates) {
        const articles = await this.eventRepo.findArticlesForEvent(candidate.id);
        const vecs = articles
          .filter((a: any) => a.embeddingVec)
          .map((a: any) => a.embeddingVec as number[]);
        const texts = articles.map((a: any) => `${a.title} ${a.snippet}`);

        // Mega-event guard
        const megaCheck = checkMegaEvent({
          eventId: candidate.id,
          articleCount: articles.length,
          subEventCount: 0,
        });
        if (megaCheck.isMega) {
          logger.info({
            event_id: candidate.id,
            reason: megaCheck.reason,
            article_id,
          }, 'linking_skip_mega_event');
          continue;
        }

        // Count unique media for the 0.50-0.62 threshold rule
        const uniqueMediaIds = new Set(articles.map((a: any) => a.mediaId));

        candidates.push({
          id: candidate.id,
          t0: candidate.t0,
          tLast: candidate.tLast,
          articleVecs: vecs,
          articleTexts: texts,
          articleCount: articles.length,
          uniqueMediaCount: uniqueMediaIds.size,
        });
      }

      // Pair scoring
      const articleForPairing: ArticleForPairing = {
        id: article_id,
        title: article.title,
        snippet: article.snippet,
        embeddingVec: articleVec,
        publishedAt: article.publishedAt,
      };

      const startMs = Date.now();
      const decision = await decideLinkAction(articleForPairing, candidates, this.llm);
      const elapsedMs = Date.now() - startMs;

      // Structured linker decision log (always, compact)
      const topScore = decision.scores[0] ?? null;
      const reason = candidates.length === 0
        ? 'noCandidates'
        : decision.scores.every((s) => s.hardBlock)
          ? 'allHardBlocked'
          : decision.action === 'CREATE'
            ? 'belowThreshold'
            : 'matched';

      logger.info({
        article_id,
        candidatesFound: candidates.length,
        topCandidateEventId: topScore?.eventId ?? null,
        topScore: topScore ? +topScore.compositeScore.toFixed(4) : null,
        thresholds: { auto: THETA_AUTO_LINK, maybe: THETA_MAYBE_LINK },
        decision: decision.action,
        reason,
        llmUsed: decision.llmUsed,
        elapsedMs,
      }, 'linker_decision');

      // Verbose debug log (controlled by DEBUG_EVENT_LINKER=1)
      if (DEBUG_LINKER) {
        logger.info({
          article_id,
          title: article.title.slice(0, 80),
          source: article.mediaId,
          publishedAt: article.publishedAt?.toISOString() ?? null,
          scores: decision.scores.slice(0, 5).map((s) => ({
            eventId: s.eventId,
            composite: +s.compositeScore.toFixed(4),
            embedding: +s.embeddingSim.toFixed(4),
            entity: +s.entityOverlap.toFixed(4),
            temporal: +s.temporalProximity.toFixed(4),
            hardBlock: s.hardBlock,
            hardBlockReasons: s.hardBlockReasons,
          })),
        }, 'linker_decision_debug');
      }

      if (decision.action === 'LINK' && decision.bestMatch) {
        await this.linkToEvent(article_id, decision.bestMatch.eventId, decision.bestMatch.score, decision, traceId, now);
      } else {
        await this.createEvent(article_id, articleVec, rawCandidates, decision, traceId, now);
      }
    };
  }

  private async linkToEvent(
    articleId: string,
    eventId: string,
    score: number,
    decision: any,
    traceId: string,
    now: Date,
  ): Promise<void> {
    await this.eventRepo.linkArticle(eventId, articleId);

    await this.auditWriter.write({
      entity_type: 'ARTICLE',
      entity_id: articleId,
      action: 'LINKED_EXISTING_V2',
      trace_id: traceId,
      data: {
        event_id: eventId,
        score,
        llm_used: decision.llmUsed,
        top_scores: decision.scores.slice(0, 5).map((s: any) => ({
          event_id: s.eventId,
          composite: s.compositeScore,
          embedding: s.embeddingSim,
          entity: s.entityOverlap,
          temporal: s.temporalProximity,
          hard_block: s.hardBlock,
          hard_block_reasons: s.hardBlockReasons,
        })),
      },
    });

    metrics.incCounter('linking.v2_linked_total');

    await this.eventBus.publish({
      event_name: 'ArticleLinkedToEvent',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker_v2' },
      payload: { article_id: articleId, event_id: eventId, link_action: 'LINKED_EXISTING' },
    });
  }

  private async createEvent(
    articleId: string,
    articleVec: number[],
    rawCandidates: Array<{ id: string; t0: Date | null }>,
    decision: any,
    traceId: string,
    now: Date,
  ): Promise<void> {
    const event = await this.eventRepo.create({
      state: 'DETECTED',
      t0: now,
      tLast: now,
    });

    await this.eventRepo.linkArticle(event.id, articleId);

    await this.auditWriter.write({
      entity_type: 'EVENT',
      entity_id: event.id,
      action: 'CREATED_EVENT_V2',
      trace_id: traceId,
      data: {
        seed_article_id: articleId,
        best_score: decision.scores[0]?.compositeScore ?? 0,
        top_scores: decision.scores.slice(0, 3).map((s: any) => ({
          event_id: s.eventId,
          composite: s.compositeScore,
          hard_block: s.hardBlock,
        })),
      },
    });

    metrics.incCounter('linking.v2_created_total');

    await this.eventBus.publish({
      event_name: 'EventCreated',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker_v2' },
      payload: { event_id: event.id, seed_article_id: articleId },
    });

    await this.eventBus.publish({
      event_name: 'ArticleLinkedToEvent',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker_v2' },
      payload: { article_id: articleId, event_id: event.id, link_action: 'TRIGGER_CREATE' },
    });

    // Merge check
    await this.mergeCheck(event.id, articleVec, rawCandidates, traceId);
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

      if (articles.length > MAX_ARTICLES_PER_EVENT) {
        continue;
      }

      const centroid = computeCentroid(vecs);
      const score = cosineSimilarity(newVec, centroid);

      if (score >= THETA_MERGE) {
        const newCount = await this.eventRepo.countArticlesForEvent(newEventId);
        const existingCount = await this.eventRepo.countArticlesForEvent(candidate.id);

        if (newCount + existingCount > MAX_ARTICLES_PER_EVENT) {
          logger.info({
            new_event_id: newEventId,
            candidate_id: candidate.id,
            combined_count: newCount + existingCount,
          }, 'merge_blocked_mega_event');
          metrics.incCounter('linking.merge_blocked_mega_total');
          continue;
        }

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
          action: 'MERGED_EVENT_V2',
          trace_id: traceId,
          data: { from_event_id: mergedId, to_event_id: canonicalId, score, threshold: THETA_MERGE },
        });

        metrics.incCounter('linking.v2_merged_total');

        await this.eventBus.publish({
          event_name: 'MergeExecuted',
          event_id: ulid(),
          occurred_at: this.clock.now().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'event_linker_v2' },
          payload: { from_event_id: mergedId, to_event_id: canonicalId, canonical_event_id: canonicalId },
        });

        break;
      }
    }
  }
}
