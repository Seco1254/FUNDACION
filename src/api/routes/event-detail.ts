import { FastifyInstance } from 'fastify';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

export function eventDetailRoutes(eventRepo: EventRepository) {
  return async function (app: FastifyInstance) {
    app.get<{ Params: { eventId: string } }>(
      '/v1/events/:eventId',
      async (request, reply) => {
        const { eventId } = request.params;

        const eventWithVersions = await eventRepo.findByIdWithLatestVersion(eventId);
        if (!eventWithVersions) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        const latestVersion = eventWithVersions.versions[0] ?? null;

        return {
          event: {
            id: eventWithVersions.id,
            state: eventWithVersions.state,
            t0: eventWithVersions.t0?.toISOString() ?? null,
            t_last: eventWithVersions.tLast?.toISOString() ?? null,
            publish_at: eventWithVersions.publishAt?.toISOString() ?? null,
            published_at: eventWithVersions.publishedAt?.toISOString() ?? null,
            closed_at: eventWithVersions.closedAt?.toISOString() ?? null,
            canonical_event_id: eventWithVersions.canonicalEventId ?? null,
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
          media_tabs: [],
          overview: { status: 'placeholder' },
          heatmap: { status: 'placeholder' },
        };
      },
    );
  };
}
