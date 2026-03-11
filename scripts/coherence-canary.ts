#!/usr/bin/env tsx
/**
 * Coherence Gate Canary Report — CLI version.
 *
 * Queries event_version rows directly (no server needed) and produces
 * a summary identical to GET /v1/debug/coherence/summary with canary
 * warnings.
 *
 * Usage:
 *   npx tsx scripts/coherence-canary.ts              # default limit=200
 *   npx tsx scripts/coherence-canary.ts --limit=500  # up to 500 events
 *   npm run debug:coherence:canary                   # via npm script
 */

import { PrismaClient } from '@prisma/client';

// ── Parse CLI args ────────────────────────────────────────────────────
const limitArg = process.argv.find((a) => a.startsWith('--limit='));
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 200;

// ── Bin helpers ───────────────────────────────────────────────────────
const BIN_LABELS = ['1', '2', '3-4', '5-9', '10+'] as const;

function articleCountBin(ac: number): (typeof BIN_LABELS)[number] {
  if (ac <= 1) return '1';
  if (ac === 2) return '2';
  if (ac <= 4) return '3-4';
  if (ac <= 9) return '5-9';
  return '10+';
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function pctls(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
  };
}

// ── Warning thresholds ────────────────────────────────────────────────
const WARN_GLOBAL_FAIL_RATE = 0.40;
const WARN_BIN2_FAIL_RATE = 0.60;

async function main() {
  const prisma = new PrismaClient();

  try {
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

    interface Row {
      event_id: string;
      status: string | null;
      avg_cosine: number | null;
      entity_jaccard: number | null;
      title_jaccard: number | null;
      stddev_drift: number | null;
      article_count: number;
      is_legacy: boolean;
    }

    const rows: Row[] = [];
    for (const v of versions) {
      const packet = v.packetJson as any;
      const cg = packet?.coherence_gate;
      if (!cg) continue;

      const m = cg.metrics ?? null;
      const d = cg.details ?? null;
      const isLegacy = m == null && d != null;

      rows.push({
        event_id: v.eventId,
        status: cg.status ?? null,
        avg_cosine: m?.avg_cosine ?? d?.embedding_cohesion ?? null,
        entity_jaccard: m?.entity_jaccard ?? d?.entity_overlap ?? null,
        title_jaccard: m?.title_jaccard ?? d?.title_alignment ?? null,
        stddev_drift: m?.stddev_drift ?? d?.topic_drift_variance ?? null,
        article_count: m?.article_count ?? (cg.status === 'NA' ? 1 : 0),
        is_legacy: isLegacy,
      });
      if (rows.length >= limit) break;
    }

    // ── Counts ──
    const total = rows.length;
    const pass = rows.filter((r) => r.status === 'PASS').length;
    const fail = rows.filter((r) => r.status === 'FAIL').length;
    const na = rows.filter((r) => r.status === 'NA').length;
    const legacy = rows.filter((r) => r.is_legacy).length;

    // ── Percentiles (evaluated only) ──
    const evaluated = rows.filter((r) => r.status !== 'NA');
    const cosines = evaluated.map((r) => r.avg_cosine).filter((v): v is number => v != null);
    const entities = evaluated.map((r) => r.entity_jaccard).filter((v): v is number => v != null);
    const titles = evaluated.map((r) => r.title_jaccard).filter((v): v is number => v != null);
    const drifts = evaluated.map((r) => r.stddev_drift).filter((v): v is number => v != null);

    // ── Bins ──
    const bins: Record<string, { total: number; pass: number; fail: number; na: number }> = {};
    for (const label of BIN_LABELS) bins[label] = { total: 0, pass: 0, fail: 0, na: 0 };
    for (const row of rows) {
      const bin = articleCountBin(row.article_count);
      bins[bin].total++;
      if (row.status === 'PASS') bins[bin].pass++;
      if (row.status === 'FAIL') bins[bin].fail++;
      if (row.status === 'NA') bins[bin].na++;
    }

    // ── Output ──
    console.log('\n══════════════════════════════════════════════════');
    console.log('  COHERENCE GATE — CANARY REPORT');
    console.log('══════════════════════════════════════════════════\n');
    console.log(`Events analyzed:  ${total}`);
    console.log(`  PASS:           ${pass}  (${total > 0 ? ((pass / total) * 100).toFixed(1) : 0}%)`);
    console.log(`  FAIL:           ${fail}  (${total > 0 ? ((fail / total) * 100).toFixed(1) : 0}%)`);
    console.log(`  NA:             ${na}  (${total > 0 ? ((na / total) * 100).toFixed(1) : 0}%)`);
    console.log(`  Legacy format:  ${legacy}`);

    console.log('\n── Percentiles (evaluated events only) ──────────\n');
    const fmtP = (label: string, p: ReturnType<typeof pctls>) =>
      `  ${label.padEnd(18)} p50=${p.p50.toFixed(4)}  p75=${p.p75.toFixed(4)}  p90=${p.p90.toFixed(4)}  (n=${p.count})`;
    console.log(fmtP('avg_cosine', pctls(cosines)));
    console.log(fmtP('entity_jaccard', pctls(entities)));
    console.log(fmtP('title_jaccard', pctls(titles)));
    console.log(fmtP('stddev_drift', pctls(drifts)));

    console.log('\n── Distribution by article_count bin ────────────\n');
    console.log('  Bin       Total  PASS  FAIL  NA    FAIL%(eval)');
    console.log('  ─────────────────────────────────────────────');
    for (const label of BIN_LABELS) {
      const b = bins[label];
      const evalN = b.pass + b.fail;
      const failPct = evalN > 0 ? ((b.fail / evalN) * 100).toFixed(1) : '-';
      console.log(
        `  ${label.padEnd(10)}${String(b.total).padEnd(7)}${String(b.pass).padEnd(6)}${String(b.fail).padEnd(6)}${String(b.na).padEnd(6)}${failPct}%`,
      );
    }

    // ── Warnings ──
    const warnings: string[] = [];
    const evaluatedTotal = pass + fail;
    const globalFailRate = evaluatedTotal > 0 ? fail / evaluatedTotal : 0;
    if (globalFailRate > WARN_GLOBAL_FAIL_RATE && evaluatedTotal >= 5) {
      warnings.push(
        `Global FAIL rate ${(globalFailRate * 100).toFixed(1)}% exceeds ${WARN_GLOBAL_FAIL_RATE * 100}% threshold (${fail}/${evaluatedTotal} evaluated)`,
      );
    }
    const bin2 = bins['2'];
    const bin2Eval = bin2.pass + bin2.fail;
    const bin2FailRate = bin2Eval > 0 ? bin2.fail / bin2Eval : 0;
    if (bin2FailRate > WARN_BIN2_FAIL_RATE && bin2Eval >= 3) {
      warnings.push(
        `article_count=2 FAIL rate ${(bin2FailRate * 100).toFixed(1)}% exceeds ${WARN_BIN2_FAIL_RATE * 100}% — thresholds may be too aggressive for small clusters`,
      );
    }

    if (warnings.length > 0) {
      console.log('\n── WARNINGS ─────────────────────────────────────\n');
      for (const w of warnings) console.log(`  ⚠ ${w}`);
    } else {
      console.log('\n── No warnings ──────────────────────────────────');
    }

    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[canary] FATAL:', e);
  process.exit(1);
});
