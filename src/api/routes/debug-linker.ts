import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { AuditRepository } from '../../modules/audit/repo/audit-repo.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

export function debugLinkerRoutes(
  auditRepo: AuditRepository,
  eventRepo: EventRepository,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get<{ Querystring: { event_id?: string; limit?: string } }>(
      '/v1/debug/linker/diagnostics',
      async (request, reply) => {
        const eventId = request.query.event_id;
        const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);

        if (!eventId) {
          return reply.status(400).send({
            error: 'Missing event_id parameter',
            usage: 'GET /v1/debug/linker/diagnostics?event_id=<uuid>&limit=20',
          });
        }

        // Get event details
        const event = await eventRepo.findByIdWithDetails(eventId);
        if (!event) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        // Get audit logs for this event (linking decisions, splits, merges)
        const auditLogs = await auditRepo.findByEntityId(eventId);

        // Also get audit logs for articles linked to this event
        const articleIds = event.eventArticles?.map((ea: any) => ea.article?.id).filter(Boolean) ?? [];
        const articleAudits: any[] = [];
        for (const artId of articleIds.slice(0, limit)) {
          const logs = await auditRepo.findByEntityId(artId);
          const linkLogs = logs.filter((l: any) =>
            l.action === 'LINKED_EXISTING_V2' || l.action === 'CREATED_EVENT_V2',
          );
          articleAudits.push(...linkLogs);
        }

        // Build diagnostics response
        const decisions = articleAudits
          .sort((a: any, b: any) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
          .slice(0, limit)
          .map((log: any) => ({
            article_id: log.entityId,
            action: log.action,
            occurred_at: log.occurredAt,
            data: log.data,
          }));

        const splitEvents = auditLogs
          .filter((l: any) => l.action === 'EVENT_SPLIT')
          .map((l: any) => ({
            occurred_at: l.occurredAt,
            data: l.data,
          }));

        const mergeEvents = auditLogs
          .filter((l: any) => l.action === 'MERGED_EVENT_V2')
          .map((l: any) => ({
            occurred_at: l.occurredAt,
            data: l.data,
          }));

        // Gate stats summary
        const gateStats = {
          total_decisions: decisions.length,
          gate_blocks: 0,
          gate_reasons: {} as Record<string, number>,
        };
        for (const d of decisions) {
          const gates = d.data?.gates_block_auto as string[] | undefined;
          if (gates && gates.length > 0) {
            gateStats.gate_blocks++;
            for (const reason of gates) {
              gateStats.gate_reasons[reason] = (gateStats.gate_reasons[reason] ?? 0) + 1;
            }
          }
        }

        return reply.send({
          event_id: eventId,
          event_state: event.state,
          article_count: event.eventArticles?.length ?? 0,
          decisions,
          split_events: splitEvents,
          merge_events: mergeEvents,
          gate_stats: gateStats,
        });
      },
    );

    done();
  };
}
