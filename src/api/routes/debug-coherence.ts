import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { metrics } from '../../core/metrics/metrics.js';

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
  /** true when this row was read from legacy `details` format */
  is_legacy: boolean;
}

// ── Bin labels for article_count grouping ─────────────────────────────
const BIN_LABELS = ['1', '2', '3-4', '5-9', '10+'] as const;

function articleCountBin(ac: number): (typeof BIN_LABELS)[number] {
  if (ac <= 1) return '1';
  if (ac === 2) return '2';
  if (ac <= 4) return '3-4';
  if (ac <= 9) return '5-9';
  return '10+';
}

// ── Percentile helpers ────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function computePercentiles(
  values: number[],
): { p50: number; p75: number; p90: number; count: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    count: sorted.length,
  };
}

// ── Data fetching ─────────────────────────────────────────────────────

/**
 * Fetch recent event versions, then filter in JS for those containing coherence_gate.
 * Avoids Prisma JSON-path filters (P2019 on some Postgres versions).
 * Over-fetches by 10x (min 500) so post-filter still yields enough rows.
 *
 * SOURCE OF TRUTH: `metrics` is the canonical format.
 * `details` is legacy and read only as fallback for rows not yet backfilled.
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

    // Source of truth: `metrics`. Legacy fallback: `details`.
    const m = cg.metrics ?? null;
    const d = cg.details ?? null;
    const isLegacy = m == null && d != null;

    rows.push({
      event_id: v.eventId,
      created_at: v.createdAt.toISOString(),
      headline: v.headline ?? null,
      status: cg.status ?? null,
      avg_cosine: m?.avg_cosine ?? d?.embedding_cohesion ?? null,
      entity_jaccard: m?.entity_jaccard ?? d?.entity_overlap ?? null,
      title_jaccard: m?.title_jaccard ?? d?.title_alignment ?? null,
      stddev_drift: m?.stddev_drift ?? d?.topic_drift_variance ?? null,
      article_count: m?.article_count ?? null,
      failed_checks: cg.failed_checks ?? null,
      thresholds: cg.thresholds ?? null,
      is_legacy: isLegacy,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

// ── Warning thresholds (canary guardrails) ────────────────────────────

const WARN_GLOBAL_FAIL_RATE = 0.40;    // warn if >40% events fail
const WARN_BIN2_FAIL_RATE = 0.60;       // warn if >60% of 2-article events fail

// ── Summary builder ───────────────────────────────────────────────────

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

  // Binned distribution by article_count
  const bins: Record<
    string,
    { total: number; pass: number; fail: number; na: number; fail_rate: number }
  > = {};
  for (const label of BIN_LABELS) {
    bins[label] = { total: 0, pass: 0, fail: 0, na: 0, fail_rate: 0 };
  }
  for (const row of rows) {
    const ac = row.article_count ?? (row.status === 'NA' ? 1 : 0);
    const bin = articleCountBin(ac);
    bins[bin].total++;
    if (row.status === 'PASS') bins[bin].pass++;
    if (row.status === 'FAIL') bins[bin].fail++;
    if (row.status === 'NA') bins[bin].na++;
  }
  // Compute fail_rate per bin (among evaluated only: pass + fail)
  for (const label of BIN_LABELS) {
    const b = bins[label];
    const evaluatedInBin = b.pass + b.fail;
    b.fail_rate = evaluatedInBin > 0 ? b.fail / evaluatedInBin : 0;
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

  // Legacy / observability counters
  const legacyRows = rows.filter((r) => r.is_legacy).length;

  // Update metrics gauges
  metrics.setGauge('coherence_metrics_legacy_rows', legacyRows);
  metrics.setGauge('coherence_metrics_total_rows', totalEvents);

  // Canary warnings
  const warnings: string[] = [];
  const evaluatedTotal = passCount + failCount;
  const globalFailRate = evaluatedTotal > 0 ? failCount / evaluatedTotal : 0;
  if (globalFailRate > WARN_GLOBAL_FAIL_RATE && evaluatedTotal >= 5) {
    warnings.push(
      `WARN: global FAIL rate ${(globalFailRate * 100).toFixed(1)}% exceeds ${WARN_GLOBAL_FAIL_RATE * 100}% threshold (${failCount}/${evaluatedTotal} evaluated events)`,
    );
  }
  const bin2 = bins['2'];
  const bin2Evaluated = bin2.pass + bin2.fail;
  if (bin2.fail_rate > WARN_BIN2_FAIL_RATE && bin2Evaluated >= 3) {
    warnings.push(
      `WARN: article_count=2 bin FAIL rate ${(bin2.fail_rate * 100).toFixed(1)}% exceeds ${WARN_BIN2_FAIL_RATE * 100}% threshold (${bin2.fail}/${bin2Evaluated} events) — thresholds may be too aggressive for small clusters`,
    );
  }

  return {
    total_events: totalEvents,
    pass_count: passCount,
    fail_count: failCount,
    na_count: naCount,
    pass_rate: totalEvents > 0 ? passCount / totalEvents : 0,
    fail_rate: totalEvents > 0 ? failCount / totalEvents : 0,
    na_rate: totalEvents > 0 ? naCount / totalEvents : 0,
    percentiles: {
      avg_cosine: computePercentiles(cosines),
      entity_jaccard: computePercentiles(entities),
      title_jaccard: computePercentiles(titles),
      stddev_drift: computePercentiles(drifts),
    },
    bins,
    fail_reason_frequency: failReasonCounts,
    observability: {
      legacy_rows: legacyRows,
      total_rows: totalEvents,
      legacy_pct: totalEvents > 0 ? legacyRows / totalEvents : 0,
    },
    warnings,
  };
}

// ── Routes ────────────────────────────────────────────────────────────

export function debugCoherenceRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    // ── Summary / canary endpoint ────────────────────────────────────
    app.get<{ Querystring: { limit?: string; min_articles?: string } }>(
      '/v1/debug/coherence/summary',
      async (request, reply) => {
        const limitStr = request.query.limit;
        const limit = limitStr ? parseInt(limitStr, 10) : 200;

        if (isNaN(limit) || limit < 1 || limit > 2000) {
          return reply.status(400).send({
            error: 'Invalid limit parameter',
            message: 'limit must be between 1 and 2000.',
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

    // ── Sample endpoint ──────────────────────────────────────────────
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
          is_legacy: r.is_legacy,
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
