import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';

interface CoherenceRow {
  event_id: string;
  status: string | null;
  avg_cosine: number | null;
  entity_jaccard: number | null;
  title_jaccard: number | null;
  stddev_drift: number | null;
  article_count: number | null;
  failed_checks: string[] | null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computePercentiles(values: number[]): { p25: number; p50: number; p75: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
  };
}

/**
 * Fetch coherence gate data directly from packet_json (works with or without the SQL view).
 */
async function fetchCoherenceRows(prisma: PrismaClient, limit: number): Promise<CoherenceRow[]> {
  const versions = await prisma.eventVersion.findMany({
    where: {
      packetJson: { path: ['coherence_gate'], not: undefined as any },
    },
    select: {
      eventId: true,
      packetJson: true,
    },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });

  const rows: CoherenceRow[] = [];
  for (const v of versions) {
    const packet = v.packetJson as any;
    const cg = packet?.coherence_gate;
    if (!cg) continue;
    rows.push({
      event_id: v.eventId,
      status: cg.status ?? null,
      avg_cosine: cg.metrics?.avg_cosine ?? null,
      entity_jaccard: cg.metrics?.entity_jaccard ?? null,
      title_jaccard: cg.metrics?.title_jaccard ?? null,
      stddev_drift: cg.metrics?.stddev_drift ?? null,
      article_count: cg.metrics?.article_count ?? null,
      failed_checks: cg.failed_checks ?? null,
    });
  }
  return rows;
}

export function debugCoherenceRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get<{ Querystring: { limit?: string } }>(
      '/v1/debug/coherence/summary',
      async (request, reply) => {
        const limitStr = request.query.limit;
        const limit = limitStr ? parseInt(limitStr, 10) : 100;

        if (isNaN(limit) || limit < 1 || limit > 1000) {
          return reply.status(400).send({
            error: 'Invalid limit parameter',
            message: 'limit must be between 1 and 1000.',
          });
        }

        const rows = await fetchCoherenceRows(prisma, limit);
        const totalEvents = rows.length;
        const passCount = rows.filter((r) => r.status === 'PASS').length;
        const failCount = rows.filter((r) => r.status === 'FAIL').length;

        // Collect non-null metric values
        const cosines = rows.map((r) => r.avg_cosine).filter((v): v is number => v != null);
        const entities = rows.map((r) => r.entity_jaccard).filter((v): v is number => v != null);
        const titles = rows.map((r) => r.title_jaccard).filter((v): v is number => v != null);
        const drifts = rows.map((r) => r.stddev_drift).filter((v): v is number => v != null);

        // Distribution by article_count
        const byArticleCount: Record<number, { total: number; pass: number; fail: number }> = {};
        for (const row of rows) {
          const ac = row.article_count ?? 0;
          if (!byArticleCount[ac]) {
            byArticleCount[ac] = { total: 0, pass: 0, fail: 0 };
          }
          byArticleCount[ac].total++;
          if (row.status === 'PASS') byArticleCount[ac].pass++;
          if (row.status === 'FAIL') byArticleCount[ac].fail++;
        }

        // Failure reason frequency
        const failReasonCounts: Record<string, number> = {};
        for (const row of rows) {
          if (row.failed_checks) {
            for (const check of row.failed_checks) {
              failReasonCounts[check] = (failReasonCounts[check] ?? 0) + 1;
            }
          }
        }

        return reply.send({
          total_events: totalEvents,
          pass_rate: totalEvents > 0 ? passCount / totalEvents : 0,
          fail_rate: totalEvents > 0 ? failCount / totalEvents : 0,
          pass_count: passCount,
          fail_count: failCount,
          percentiles: {
            avg_cosine: computePercentiles(cosines),
            entity_jaccard: computePercentiles(entities),
            title_jaccard: computePercentiles(titles),
            stddev_drift: computePercentiles(drifts),
          },
          distribution_by_article_count: byArticleCount,
          fail_reason_frequency: failReasonCounts,
        });
      },
    );

    done();
  };
}
