/**
 * Directly regenerates LLM overviews for all PUBLISHED events.
 *
 * Bypasses the event bus / scheduler — calls OverviewGenerator.handler()
 * inline for each event, in sequence.
 *
 * Usage:
 *   npx tsx scripts/regenerate-overviews.ts [--limit=N] [--event-id=UUID]
 *
 * Requires OPENAI_API_KEY (or ANTHROPIC_API_KEY) to be set.
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { LlmClient } from '../src/core/llm/client.js';
import { ClaimRepository } from '../src/modules/claims/repo/claim-repo.js';
import { VersionRepository } from '../src/modules/versions/repo/version-repo.js';
import { EventRepository } from '../src/modules/events/repo/event-repo.js';
import { OverviewGenerator } from '../src/modules/overview/service/overview-generator.js';
import { EventBus } from '../src/core/event_bus/index.js';
import { AuditLogWriter } from '../src/core/event_bus/dispatcher.js';
import { logger } from '../src/core/logging/logger.js';

const prisma = new PrismaClient();

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith('--limit='));
const eventIdArg = args.find((a) => a.startsWith('--event-id='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1], 10) : 50;
const TARGET_EVENT_ID = eventIdArg ? eventIdArg.split('=')[1] : null;

async function main() {
  const llmClient = new LlmClient();
  if (!llmClient.isAvailable()) {
    console.error('❌ No LLM provider configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env');
    process.exit(1);
  }
  console.log(`✅ LLM provider: ${llmClient.activeProvider}`);

  const eventBus = new EventBus();
  // No-op audit writer for this script
  const auditWriter: AuditLogWriter = {
    write: async () => {},
  };

  const claimRepo = new ClaimRepository(prisma);
  const versionRepo = new VersionRepository(prisma);
  const eventRepo = new EventRepository(prisma);
  const generator = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter, llmClient, eventRepo);
  const handler = generator.handler();

  // Fetch published events
  const where = TARGET_EVENT_ID
    ? { state: 'PUBLISHED' as const, id: TARGET_EVENT_ID }
    : { state: 'PUBLISHED' as const };

  const events = await prisma.event.findMany({
    where,
    include: { versions: { orderBy: { createdAt: 'desc' as const }, take: 1 } },
    orderBy: { publishedAt: 'desc' as const },
    take: LIMIT,
  });

  console.log(`Processing ${events.length} published events (limit=${LIMIT})...`);

  let llmCount = 0;
  let heuristicCount = 0;
  let errorCount = 0;

  for (const ev of events) {
    const version = ev.versions[0];
    if (!version) { heuristicCount++; continue; }

    const traceId = ulid();
    try {
      await handler({
        event_name: 'OverviewRequested',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'regenerate-overviews' },
        payload: { event_id: ev.id, version_id: version.id },
      });

      // Check result
      const updated = await versionRepo.findById(version.id);
      const mode = (updated?.packetJson as any)?.overview_mode ?? 'none';
      if (mode === 'llm') {
        llmCount++;
        console.log(`  ✅ LLM  ${ev.id.slice(0, 8)} | ${version.headline?.slice(0, 60)}`);
      } else {
        heuristicCount++;
        console.log(`  ⚠️  ${mode.padEnd(9)} ${ev.id.slice(0, 8)} | ${version.headline?.slice(0, 60)}`);
      }
    } catch (err) {
      errorCount++;
      console.error(`  ❌ ERROR ${ev.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\n=== RESULTS ===`);
  console.log(`  llm:       ${llmCount}`);
  console.log(`  heuristic: ${heuristicCount}`);
  console.log(`  errors:    ${errorCount}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
