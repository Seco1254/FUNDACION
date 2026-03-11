/**
 * DB Doctor: detects data inconsistencies in the database.
 *
 * Checks:
 *   1. Media = 0 → NO_MEDIA (can't scrape)
 *   2. Media = 0 AND downstream > 0 → INCONSISTENT_DB_STATE
 *   3. Events > 0 but no PUBLISHED → NO_PUBLISHED_EVENTS
 *   4. Articles > 0 but Media = 0 → ORPHAN_ARTICLES
 *
 * Usage:  node scripts/db-doctor.js
 *         npm run db:doctor
 */
import { existsSync, readFileSync } from 'node:fs';

// ── load .env ────────────────────────────────────────────────────────
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

// ── diagnostic ───────────────────────────────────────────────────────
async function runDoctor() {
  let PrismaClient;
  try {
    const mod = await import('@prisma/client');
    PrismaClient = mod.PrismaClient;
  } catch {
    console.error(
      '\n  Prisma Client not generated.\n' +
      '  Run: npx prisma generate\n',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
  } catch (err) {
    console.error(`\n  Cannot connect to database: ${err?.message ?? err}\n`);
    console.error('  Run: npm run db:doctor   (the check-db part)\n');
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
  }

  const issues = [];

  // Core counts
  const mediaCount = await prisma.media.count();
  const mediaAllowlisted = await prisma.media.count({ where: { allowlisted: true } });
  const eventCount = await prisma.event.count();
  const articleCount = await prisma.article.count();

  // Downstream counts (tables that should only have data if core tables do)
  const biasLabelCount = await prisma.biasLabel.count();
  const topicAssignmentCount = await prisma.topicAssignment.count();
  const mediaProfileCount = await prisma.mediaProfile.count();
  const eventVersionCount = await prisma.eventVersion.count();

  // Published events
  let publishedCount = 0;
  if (eventCount > 0) {
    publishedCount = await prisma.event.count({ where: { state: 'PUBLISHED' } });
  }

  console.log('\n  ═══ DB Doctor Report ═══\n');
  console.log('  Core tables:');
  console.log(`    Media:          ${mediaCount} (allowlisted: ${mediaAllowlisted})`);
  console.log(`    Event:          ${eventCount} (published: ${publishedCount})`);
  console.log(`    Article:        ${articleCount}`);
  console.log(`    EventVersion:   ${eventVersionCount}`);
  console.log('');
  console.log('  Downstream tables:');
  console.log(`    BiasLabel:        ${biasLabelCount}`);
  console.log(`    TopicAssignment:  ${topicAssignmentCount}`);
  console.log(`    MediaProfile:     ${mediaProfileCount}`);
  console.log('');

  // ── Checks ─────────────────────────────────────────────────────────

  if (mediaCount === 0) {
    issues.push({
      code: 'NO_MEDIA',
      severity: 'CRITICAL',
      message: 'Media table is empty. Scraping cannot discover articles.',
      fix: 'npm run db:seed:minimal',
    });
  } else if (mediaAllowlisted === 0) {
    issues.push({
      code: 'NO_ALLOWLISTED_MEDIA',
      severity: 'CRITICAL',
      message: `${mediaCount} media rows exist but none are allowlisted.`,
      fix: 'npm run db:seed:minimal   (or set allowlisted=true on existing rows)',
    });
  }

  const downstreamTotal = biasLabelCount + topicAssignmentCount + mediaProfileCount;
  if (mediaCount === 0 && downstreamTotal > 0) {
    issues.push({
      code: 'INCONSISTENT_DB_STATE',
      severity: 'CRITICAL',
      message: `Media=0 but downstream tables have ${downstreamTotal} rows (BiasLabel=${biasLabelCount}, TopicAssignment=${topicAssignmentCount}, MediaProfile=${mediaProfileCount}). Database was likely reset without clearing downstream data.`,
      fix: 'npm run reset:db          (migrate + seed) or: npm run db:reset (full wipe + re-migrate)',
    });
  }

  if (eventCount > 0 && publishedCount === 0) {
    issues.push({
      code: 'NO_PUBLISHED_EVENTS',
      severity: 'WARNING',
      message: `${eventCount} events exist but none are PUBLISHED. Feed will be empty.`,
      fix: 'POST /v1/debug/lifecycle/tick   (force-publish pending events)',
    });
  }

  if (articleCount > 0 && mediaCount === 0) {
    issues.push({
      code: 'ORPHAN_ARTICLES',
      severity: 'WARNING',
      message: `${articleCount} articles exist but Media=0. Foreign key integrity may be broken.`,
      fix: 'npm run reset:db',
    });
  }

  // ── Results ────────────────────────────────────────────────────────
  if (issues.length === 0) {
    console.log('  Status: HEALTHY\n');
  } else {
    console.log(`  Status: ${issues.length} issue(s) found\n`);
    for (const issue of issues) {
      console.log(`  [${issue.severity}] ${issue.code}`);
      console.log(`    ${issue.message}`);
      console.log(`    Fix: ${issue.fix}\n`);
    }
  }

  await prisma.$disconnect();

  const hasCritical = issues.some((i) => i.severity === 'CRITICAL');
  if (hasCritical) {
    process.exit(1);
  }
}

runDoctor().catch((e) => {
  console.error('db-doctor failed:', e);
  process.exit(1);
});
