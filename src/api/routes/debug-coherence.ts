import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';

interface CoherenceRow {
  event_id: string;
  created_at: string;
  headline: string | null;
  status: string | null;
  avg_cosine: number | null;
  entity_jaccard: number | null;
  title_jaccard: number | null;
  stddev_drift: number | null;
  article_count: number | null;
  failed_checks: string[] | null;
  thresholds: Record<string, number> | null;
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
 * Fetch recent event versions, then filter in JS for those containing coherence_gate.
 * Avoids Prisma JSON-path filters (P2019 on some Postgres versions).
 * Over-fetches by 10x (min 500) so post-filter still yields enough rows.
 */
async function fetchCoherenceRows(prisma: PrismaClient, limit: number): Promise<CoherenceRow[]> {
  const fetchLimit = Math.max(limit * 10, 500);
  const versions = await prisma.eventVersion.findMany({
    select: {
      eventId: true,
      createdAt: true,
      headline: true,
      packetJson: true,
    },
    orderBy: { createdAt: 'desc' },
    take: fetchLimit,
  });

  const rows: CoherenceRow[] = [];
  for (const v of versions) {
    const packet = v.packetJson as any;
    const cg = packet?.coherence_gate;
    if (!cg) continue;
    rows.push({
      event_id: v.eventId,
      created_at: v.createdAt.toISOString(),
      headline: v.headline ?? null,
      status: cg.status ?? null,
      avg_cosine: cg.metrics?.avg_cosine ?? null,
      entity_jaccard: cg.metrics?.entity_jaccard ?? null,
      title_jaccard: cg.metrics?.title_jaccard ?? null,
      stddev_drift: cg.metrics?.stddev_drift ?? null,
      article_count: cg.metrics?.article_count ?? null,
      failed_checks: cg.failed_checks ?? null,
      thresholds: cg.thresholds ?? null,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

function buildSummary(rows: CoherenceRow[]) {
  const totalEvents = rows.length;
  const passCount = rows.filter((r) => r.status === 'PASS').length;
  const failCount = rows.filter((r) => r.status === 'FAIL').length;
  const naCount = rows.filter((r) => r.status === 'NA').length;

  // Percentiles only from evaluated rows (status !== 'NA') with numeric metrics
  const evaluated = rows.filter((r) => r.status !== 'NA');
  const cosines = evaluated.map((r) => r.avg_cosine).filter((v): v is number => v != null);
  const entities = evaluated.map((r) => r.entity_jaccard).filter((v): v is number => v != null);
  const titles = evaluated.map((r) => r.title_jaccard).filter((v): v is number => v != null);
  const drifts = evaluated.map((r) => r.stddev_drift).filter((v): v is number => v != null);

  // Distribution by article_count
  const byArticleCount: Record<number, { total: number; pass: number; fail: number; na: number }> = {};
  for (const row of rows) {
    const ac = row.article_count ?? 0;
    if (!byArticleCount[ac]) {
      byArticleCount[ac] = { total: 0, pass: 0, fail: 0, na: 0 };
    }
    byArticleCount[ac].total++;
    if (row.status === 'PASS') byArticleCount[ac].pass++;
    if (row.status === 'FAIL') byArticleCount[ac].fail++;
    if (row.status === 'NA') byArticleCount[ac].na++;
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

  return {
    total_events: totalEvents,
    pass_rate: totalEvents > 0 ? passCount / totalEvents : 0,
    fail_rate: totalEvents > 0 ? failCount / totalEvents : 0,
    na_rate: totalEvents > 0 ? naCount / totalEvents : 0,
    pass_count: passCount,
    fail_count: failCount,
    na_count: naCount,
    percentiles: {
      avg_cosine: computePercentiles(cosines),
      entity_jaccard: computePercentiles(entities),
      title_jaccard: computePercentiles(titles),
      stddev_drift: computePercentiles(drifts),
    },
    distribution_by_article_count: byArticleCount,
    fail_reason_frequency: failReasonCounts,
  };
}

export function debugCoherenceRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    // ── Summary endpoint ──────────────────────────────────────────────
    app.get<{ Querystring: { limit?: string; min_articles?: string } }>(
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

        const minArticlesStr = request.query.min_articles;
        const minArticles = minArticlesStr ? parseInt(minArticlesStr, 10) : 0;

        if (isNaN(minArticles) || minArticles < 0 || minArticles > 100) {
          return reply.status(400).send({
            error: 'Invalid min_articles parameter',
            message: 'min_articles must be between 0 and 100.',
          });
        }

        const allRows = await fetchCoherenceRows(prisma, limit);
        const filtered = minArticles > 0
          ? allRows.filter((r) => (r.article_count ?? 0) >= minArticles)
          : allRows;

        return reply.send(buildSummary(filtered));
      },
    );

    // ── Sample endpoint ───────────────────────────────────────────────
    app.get<{ Querystring: { limit?: string; status?: string; min_articles?: string } }>(
      '/v1/debug/coherence/sample',
      async (request, reply) => {
        const limitStr = request.query.limit;
        const limit = limitStr ? parseInt(limitStr, 10) : 50;

        if (isNaN(limit) || limit < 1 || limit > 500) {
          return reply.status(400).send({
            error: 'Invalid limit parameter',
            message: 'limit must be between 1 and 500.',
          });
        }

        const statusFilter = request.query.status?.toUpperCase() ?? null;
        if (statusFilter && !['PASS', 'FAIL', 'NA'].includes(statusFilter)) {
          return reply.status(400).send({
            error: 'Invalid status parameter',
            message: 'status must be PASS, FAIL, or NA.',
          });
        }

        const minArticlesStr = request.query.min_articles;
        const minArticles = minArticlesStr ? parseInt(minArticlesStr, 10) : 0;

        if (isNaN(minArticles) || minArticles < 0 || minArticles > 100) {
          return reply.status(400).send({
            error: 'Invalid min_articles parameter',
            message: 'min_articles must be between 0 and 100.',
          });
        }

        // Fetch more than limit to allow filtering
        const fetchLimit = limit * 5;
        const allRows = await fetchCoherenceRows(prisma, fetchLimit);

        let filtered = allRows;
        if (statusFilter) {
          filtered = filtered.filter((r) => r.status === statusFilter);
        }
        if (minArticles > 0) {
          filtered = filtered.filter((r) => (r.article_count ?? 0) >= minArticles);
        }

        const rows = filtered.slice(0, limit).map((r) => ({
          event_id: r.event_id,
          created_at: r.created_at,
          headline: r.headline,
          status: r.status,
          failed_checks: r.failed_checks,
          metrics: {
            avg_cosine: r.avg_cosine,
            entity_jaccard: r.entity_jaccard,
            title_jaccard: r.title_jaccard,
            stddev_drift: r.stddev_drift,
            article_count: r.article_count,
          },
          thresholds: r.thresholds,
        }));

        return reply.send({
          total: rows.length,
          filters: {
            status: statusFilter,
            min_articles: minArticles,
            limit,
          },
          rows,
        });
      },
    );

    done();
  };
}
