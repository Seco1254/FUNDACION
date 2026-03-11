#!/usr/bin/env tsx
/**
 * Backfill coherence_gate metrics — idempotent.
 *
 * For event_version rows where packet_json.coherence_gate.details exists
 * but packet_json.coherence_gate.metrics does NOT, copies details → metrics
 * using the canonical field names.
 *
 * Safe to run multiple times.  Zero-downtime (UPDATE only, no DDL).
 *
 * Usage:
 *   npx tsx scripts/backfill-coherence-metrics.ts          # dry-run
 *   npx tsx scripts/backfill-coherence-metrics.ts --apply   # apply changes
 */

import { PrismaClient } from '@prisma/client';

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  const prisma = new PrismaClient();

  try {
    // 1. Find rows with legacy `details` but no `metrics`
    const rows: Array<{ id: string; packetJson: any }> = await prisma.$queryRaw`
      SELECT ev.id, ev.packet_json AS "packetJson"
      FROM event_version ev
      WHERE ev.packet_json ? 'coherence_gate'
        AND ev.packet_json->'coherence_gate' ? 'details'
        AND NOT (ev.packet_json->'coherence_gate' ? 'metrics')
    `;

    const totalLegacy = rows.length;
    console.log(`[backfill] legacy rows (details without metrics): ${totalLegacy}`);

    if (totalLegacy === 0) {
      console.log('[backfill] nothing to do — all rows already use metrics format.');
      return;
    }

    if (DRY_RUN) {
      console.log('[backfill] DRY RUN — pass --apply to write changes.');
      for (const row of rows.slice(0, 5)) {
        const d = row.packetJson?.coherence_gate?.details;
        console.log(`  id=${row.id}  embedding_cohesion=${d?.embedding_cohesion}  entity_overlap=${d?.entity_overlap}`);
      }
      if (rows.length > 5) console.log(`  ... and ${rows.length - 5} more`);
      return;
    }

    // 2. Backfill: transform details → metrics
    let backfilled = 0;
    for (const row of rows) {
      const cg = row.packetJson.coherence_gate;
      const d = cg.details ?? {};

      const metrics = {
        avg_cosine: d.embedding_cohesion ?? null,
        entity_jaccard: d.entity_overlap ?? null,
        title_jaccard: d.title_alignment ?? null,
        stddev_drift: d.topic_drift_variance ?? null,
        article_count: d.article_count ?? null,
      };

      // Build updated coherence_gate with metrics added
      const updatedCg = { ...cg, metrics };
      const updatedPacket = { ...row.packetJson, coherence_gate: updatedCg };

      await prisma.eventVersion.update({
        where: { id: row.id },
        data: { packetJson: updatedPacket },
      });
      backfilled++;
    }

    console.log(`[backfill] done: ${backfilled}/${totalLegacy} rows backfilled.`);

    // 3. Verify: count remaining legacy rows
    const remaining: Array<{ count: bigint }> = await prisma.$queryRaw`
      SELECT count(*) AS count
      FROM event_version ev
      WHERE ev.packet_json ? 'coherence_gate'
        AND ev.packet_json->'coherence_gate' ? 'details'
        AND NOT (ev.packet_json->'coherence_gate' ? 'metrics')
    `;
    console.log(`[backfill] remaining legacy rows: ${remaining[0].count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('[backfill] FATAL:', e);
  process.exit(1);
});
