import { FastifyInstance } from 'fastify';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

export function biasRoutes(eventRepo: EventRepository, biasRepo: BiasLabelRepository) {
  return async function (app: FastifyInstance) {
    app.get<{ Params: { eventId: string; mediaKey: string } }>(
      '/v1/events/:eventId/bias/:mediaKey',
      async (request, reply) => {
        const { eventId, mediaKey } = request.params;

        const eventWithDetails = await eventRepo.findByIdWithDetails(eventId);
        if (!eventWithDetails) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        const latestVersion = eventWithDetails.versions[0] ?? null;
        if (!latestVersion) {
          return reply.status(404).send({ error: 'No version available' });
        }

        // Find media_id by mediaKey from articles
        let mediaId: string | null = null;
        for (const ea of eventWithDetails.eventArticles ?? []) {
          if ((ea as any).article?.media?.mediaKey === mediaKey) {
            mediaId = (ea as any).article.mediaId ?? (ea as any).article.media?.id ?? null;
            break;
          }
        }

        if (!mediaId) {
          return reply.status(404).send({ error: 'Media not found for this event' });
        }

        const allLabels = await biasRepo.findByMediaAndEvent(mediaId, eventId);

        const mediaLevel = allLabels.filter((l) => l.scope === 'MEDIA_LEVEL');
        const articleLevel = allLabels.filter((l) => l.scope === 'ARTICLE_LEVEL');

        const mediaLabelEntry = mediaLevel[0] ?? null;

        return {
          media_key: mediaKey,
          media_level: mediaLabelEntry
            ? {
                label_primary: mediaLabelEntry.labelPrimary,
                label_secondary: mediaLabelEntry.labelSecondary,
                intensity: mediaLabelEntry.intensity,
                confidence: mediaLabelEntry.confidence,
                rationale: mediaLabelEntry.rationaleJson,
              }
            : null,
          article_level: articleLevel.map((l) => ({
            article_id: l.articleId,
            label_primary: l.labelPrimary,
            label_secondary: l.labelSecondary,
            intensity: l.intensity,
            confidence: l.confidence,
            rationale: l.rationaleJson,
          })),
        };
      },
    );
  };
}
