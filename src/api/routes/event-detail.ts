import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

export function eventDetailRoutes(eventRepo: EventRepository) {
  return async function (app: FastifyInstance) {
    app.get<{ Params: { eventId: string } }>(
      '/v1/events/:eventId',
      async (request, reply) => {
        const { eventId } = request.params;

        const eventWithDetails = await eventRepo.findByIdWithDetails(eventId);
        if (!eventWithDetails) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        const latestVersion = eventWithDetails.versions[0] ?? null;

        const articles = (eventWithDetails.eventArticles ?? []).map((ea: any) => ({
          article_id: ea.article.id,
          media_key: ea.article.media?.mediaKey ?? 'unknown',
          title: ea.article.title,
          snippet: ea.article.snippet,
          url: ea.article.url,
          published_at: ea.article.publishedAt?.toISOString?.() ?? null,
        }));

        const mediaMap = new Map<string, any[]>();
        for (const a of articles) {
          const list = mediaMap.get(a.media_key) ?? [];
          list.push(a);
          mediaMap.set(a.media_key, list);
        }

        const mediaTabs = Array.from(mediaMap.entries()).map(([key, items]) => ({
          media_key: key,
          articles: items,
        }));

        return {
          event: {
            id: eventWithDetails.id,
            state: eventWithDetails.state,
            t0: eventWithDetails.t0?.toISOString() ?? null,
            t_last: eventWithDetails.tLast?.toISOString() ?? null,
            publish_at: eventWithDetails.publishAt?.toISOString() ?? null,
            published_at: eventWithDetails.publishedAt?.toISOString() ?? null,
            closed_at: eventWithDetails.closedAt?.toISOString() ?? null,
            canonical_event_id: eventWithDetails.canonicalEventId ?? null,
          },
          latest_version: latestVersion
            ? {
                version_index: latestVersion.versionIndex,
                gate_status: latestVersion.gateStatus,
                headline: latestVersion.headline ?? null,
                packet_json: latestVersion.packetJson ?? {},
                diff_json: latestVersion.diffJson ?? {},
              }
            : null,
          media_tabs: mediaTabs,
          overview: { status: 'NOT_READY_PHASE_2' },
          heatmap: { status: 'placeholder' },
        };
      },
    );
  };
}
