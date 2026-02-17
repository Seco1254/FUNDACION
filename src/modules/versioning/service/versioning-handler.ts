import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { logger } from '../../../core/logging/logger.js';

export class VersioningHandler {
  constructor(
    private eventRepo: EventRepository,
    private versionRepo: VersionRepository,
    private mediaRepo: MediaRepository,
    private eventBus: EventBus,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, trigger } = envelope.payload as { event_id: string; trigger: string };
      const traceId = envelope.trace.trace_id;

      const event = await this.eventRepo.findById(event_id);
      if (!event) {
        logger.error({ event_id }, 'event_not_found_for_versioning');
        return;
      }

      const latest = await this.versionRepo.findLatestByEventId(event_id);
      const nextIndex = latest ? latest.versionIndex + 1 : 0;

      const articles = await this.eventRepo.findArticlesForEvent(event_id);

      const articleRefs = await Promise.all(
        articles.map(async (a: any) => {
          const media = await this.mediaRepo.findById(a.mediaId);
          return {
            article_id: a.id,
            media_key: media?.mediaKey ?? 'unknown',
            published_at: a.publishedAt?.toISOString?.() ?? null,
            title: a.title,
            snippet: a.snippet,
            url: a.url,
          };
        }),
      );

      const latestArticle = articles.length > 0 ? articles[articles.length - 1] : null;
      const headline = latestArticle?.title ?? event.t0?.toISOString() ?? 'No headline';

      const packetJson = {
        event_id,
        version_index: nextIndex,
        state: event.state,
        t0: event.t0?.toISOString() ?? null,
        t_last: event.tLast?.toISOString() ?? null,
        published_at: event.publishedAt?.toISOString() ?? null,
        headline,
        articles: articleRefs,
      };

      const previousArticleIds = latest
        ? ((latest.packetJson as any)?.articles ?? []).map((a: any) => a.article_id)
        : [];
      const currentArticleIds = articleRefs.map((a) => a.article_id);
      const addedArticles = currentArticleIds.filter((id: string) => !previousArticleIds.includes(id));

      const diffJson = {
        added_articles: addedArticles,
        reason: trigger,
      };

      const version = await this.versionRepo.create({
        eventId: event_id,
        versionIndex: nextIndex,
        headline,
        packetJson,
        diffJson,
      });

      await this.eventBus.publish({
        event_name: 'EventVersionCommitted',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'versioning' },
        payload: { event_id, version_id: version.id, version_index: nextIndex },
      });
    };
  }
}
