import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import type { PrismaClient } from '@prisma/client';

const VALID_LABELS = [
  'GOOD', 'BAD_MERGE', 'BAD_SOURCE', 'BAD_TOPIC',
  'BAD_IMPORTANCE', 'BAD_ADS_COMMERCIAL', 'BAD_OTHER',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function debugLabelsRoutes(prisma: PrismaClient): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {

    /**
     * GET /v1/debug/labels?sinceHours=168&limit=50&label=BAD_MERGE
     */
    app.get<{ Querystring: { sinceHours?: string; limit?: string; label?: string } }>(
      '/v1/debug/labels',
      async (request, reply) => {
        const q = request.query as any;
        const sinceHours = parseInt(q.sinceHours ?? '168', 10);
        const limit = Math.min(parseInt(q.limit ?? '50', 10), 500);
        const labelFilter = q.label?.toUpperCase();

        if (labelFilter && !(VALID_LABELS as readonly string[]).includes(labelFilter)) {
          return reply.status(400).send({
            error: `Invalid label filter "${labelFilter}". Valid: ${VALID_LABELS.join(', ')}`,
          });
        }

        const where: any = {};
        if (sinceHours > 0) {
          where.createdAt = { gte: new Date(Date.now() - sinceHours * 60 * 60 * 1000) };
        }
        if (labelFilter) {
          where.label = labelFilter;
        }

        const rows = await prisma.eventLabel.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: limit,
        });

        return reply.send({
          count: rows.length,
          labels: rows.map((r) => ({
            id: r.id,
            event_id: r.eventId,
            label: r.label,
            note: r.note,
            git_sha: r.gitSha,
            created_at: r.createdAt.toISOString(),
            has_snapshot: Object.keys((r.snapshotJson as any) ?? {}).length > 0,
          })),
        });
      },
    );

    /**
     * POST /v1/debug/labels  { event_id, label, note?, snapshot? }
     */
    app.post<{ Body: { event_id: string; label: string; note?: string; snapshot?: boolean } }>(
      '/v1/debug/labels',
      async (request, reply) => {
        const body = request.body as any;
        const eventId = body?.event_id;
        const label = (body?.label ?? '').toUpperCase();
        const note = body?.note ?? null;

        if (!eventId || !UUID_RE.test(eventId)) {
          return reply.status(400).send({ error: 'Missing or invalid event_id (UUID required)' });
        }

        if (!(VALID_LABELS as readonly string[]).includes(label)) {
          return reply.status(400).send({
            error: `Invalid label "${label}". Valid: ${VALID_LABELS.join(', ')}`,
          });
        }

        if (label === 'BAD_OTHER' && (!note || note.trim().length === 0)) {
          return reply.status(400).send({ error: 'BAD_OTHER requires a non-empty note' });
        }

        // Snapshot is optional via API (default false to keep responses fast)
        const snapshotJson = {};

        const created = await prisma.eventLabel.create({
          data: {
            eventId,
            label,
            note,
            gitSha: null,
            snapshotJson: snapshotJson as any,
          },
        });

        return reply.status(201).send({
          id: created.id,
          event_id: created.eventId,
          label: created.label,
          note: created.note,
          created_at: created.createdAt.toISOString(),
        });
      },
    );

    done();
  };
}
