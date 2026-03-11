#!/usr/bin/env tsx
/**
 * Event Labels CLI — manual quality labeling for events.
 *
 * Commands:
 *   label    Create/add a label for an event
 *   unlabel  Remove labels for an event
 *   list     List recent labels
 *   stats    Aggregate label counts
 *
 * Usage:
 *   npm run debug:events:label -- label   --event_id=<uuid> --label=GOOD
 *   npm run debug:events:label -- label   --event_id=<uuid> --label=BAD_OTHER --note="descripción"
 *   npm run debug:events:label -- unlabel --event_id=<uuid>
 *   npm run debug:events:label -- unlabel --event_id=<uuid> --all=1
 *   npm run debug:events:label -- list    --limit=50 --label=BAD_MERGE --sinceHours=168
 *   npm run debug:events:label -- stats
 *   npm run debug:events:label -- stats   --format=table
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { evaluatePublishGate, computeImportanceScore, computeDemotionMultiplier } from '../src/core/llm/gates.js';
import { aggregateEventTopic } from '../src/modules/topics/service/topic-heuristic.js';
import { extractDeskDetailed } from '../src/modules/event_linker/service/hard-negative-gates.js';
import { detectIntraSplitProxy } from '../src/modules/quality/detectors/intra-split-proxy.js';

// ── Constants ────────────────────────────────────────────────────

export const VALID_LABELS = [
  'GOOD',
  'BAD_MERGE',
  'BAD_SOURCE',
  'BAD_TOPIC',
  'BAD_IMPORTANCE',
  'BAD_ADS_COMMERCIAL',
  'BAD_OTHER',
] as const;

export type LabelValue = (typeof VALID_LABELS)[number];

// ── CLI arg parsing (same pattern as feed-doctor) ────────────────

export function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const flags: Record<string, string> = {};
  let command = '';
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) {
      flags[m[1]] = m[2];
    } else if (!a.startsWith('-') && !command) {
      command = a;
    }
  }
  return { command, flags };
}

// ── Helpers ──────────────────────────────────────────────────────

function gitSha(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function validateLabel(label: string): label is LabelValue {
  return (VALID_LABELS as readonly string[]).includes(label);
}

export function validateLabelInput(input: {
  label: string;
  note?: string;
}): { valid: true } | { valid: false; error: string } {
  if (!validateLabel(input.label)) {
    return { valid: false, error: `Invalid label "${input.label}". Valid: ${VALID_LABELS.join(', ')}` };
  }
  if (input.label === 'BAD_OTHER' && (!input.note || input.note.trim().length === 0)) {
    return { valid: false, error: 'BAD_OTHER requires a non-empty --note' };
  }
  return { valid: true };
}

export function formatOutput(records: any[], format: 'json' | 'ndjson' | 'table'): string {
  if (format === 'json') {
    return JSON.stringify(records, null, 2);
  }
  if (format === 'table') {
    return formatTable(records);
  }
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

function formatTable(records: any[]): string {
  if (records.length === 0) return '(no records)\n';
  const lines: string[] = [];
  for (const r of records) {
    if (r.kind === 'label') {
      const eid = (r.event_id ?? '').slice(0, 8);
      const ts = r.created_at ? new Date(r.created_at).toISOString().slice(0, 16) : '?';
      lines.push(`${ts}  ${eid}…  ${(r.label ?? '').padEnd(20)} ${r.note ?? ''}`);
    } else if (r.kind === 'stats') {
      lines.push('── Label Stats ──');
      for (const s of r.counts ?? []) {
        lines.push(`  ${String(s.label).padEnd(22)} ${s.count}`);
      }
      lines.push(`  ${'TOTAL'.padEnd(22)} ${r.total}`);
      if (r.top_notes?.length > 0) {
        lines.push('── Top Notes ──');
        for (const n of r.top_notes) {
          lines.push(`  (${n.count}) ${n.note}`);
        }
      }
    } else {
      lines.push(JSON.stringify(r));
    }
  }
  return lines.join('\n') + '\n';
}

// ── Snapshot builder ─────────────────────────────────────────────

export async function buildSnapshot(
  prisma: PrismaClient,
  eventId: string,
): Promise<Record<string, any>> {
  const event = await prisma.event.findUnique({
    where: { id: eventId },
    include: {
      versions: { orderBy: { versionIndex: 'desc' as const }, take: 1 },
      eventArticles: {
        include: {
          article: {
            select: {
              id: true, url: true, title: true, snippet: true,
              textContentLen: true, textContentSource: true,
              usableForOverview: true, contentType: true,
              routingDecision: true, status: true, blockedReason: true,
              media: { select: { id: true, mediaKey: true, name: true } },
            },
          },
        },
      },
    },
  });

  if (!event) {
    return { error: 'event_not_found' };
  }

  const articles = event.eventArticles.map((ea: any) => ea.article);
  const version = event.versions[0] ?? null;
  const packet: any = version?.packetJson ?? {};

  // Coverage
  const mediaMap = new Map<string, number>();
  for (const a of articles) {
    const key = a.media?.mediaKey ?? 'unknown';
    mediaMap.set(key, (mediaMap.get(key) ?? 0) + 1);
  }
  const numSources = mediaMap.size;
  const sources = [...mediaMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([mediaKey, count]) => ({ mediaKey, count }));

  // Coherence
  const coherenceGate = packet.coherence_gate ?? null;

  // Split proxy
  const splitResult = detectIntraSplitProxy(
    articles.map((a: any) => ({ title: a.title ?? null, url: a.url ?? null, contentType: a.contentType ?? null })),
  );

  // Topic
  const headline = version?.headline ?? '';
  const aiWhText = Array.isArray(packet.ai_overview?.what_happened)
    ? packet.ai_overview.what_happened.join(' ')
    : '';
  const articleInputs = articles.map((a: any) => ({
    title: a.title ?? null, url: a.url ?? null, contentType: a.contentType ?? null,
  }));
  const topicResult = aggregateEventTopic(headline, articleInputs, aiWhText || null);

  // Representative article
  const sortedArts = [...articles].sort((a: any, b: any) => {
    const aCt = a.contentType === 'news' ? 0 : 1;
    const bCt = b.contentType === 'news' ? 0 : 1;
    if (aCt !== bCt) return aCt - bCt;
    return (b.textContentLen ?? 0) - (a.textContentLen ?? 0);
  });
  const repArt = sortedArts[0] ?? null;
  const repDeskResult = repArt ? extractDeskDetailed(repArt.url) : { desk: null, desk_source: 'none' as const };

  // Usable text
  const usableArticles = articles.filter((a: any) => a.usableForOverview);
  const totalUsableTextLen = usableArticles.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0);

  // Importance
  const hoursAge = event.publishedAt
    ? (Date.now() - new Date(event.publishedAt).getTime()) / (3600 * 1000)
    : null;
  const importanceScore = computeImportanceScore({
    topic_key: topicResult.topic_key,
    text_len: totalUsableTextLen,
    hours_since_published: hoursAge,
    unique_sources_count: numSources,
  });

  // Demotion
  const demotion = computeDemotionMultiplier({
    unique_sources_count: numSources,
    topic_confidence: topicResult.topic_confidence,
    topic_key: topicResult.topic_key,
    total_usable_text_len: totalUsableTextLen,
  });

  // Eligibility
  const feedAllowedTopics: string[] = (process.env.FEED_ALLOWED_TOPICS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const keyFactsCount: number = packet.key_facts_count ?? 0;
  const overviewStatus = packet.ai_overview ? 'ready' : 'pending';
  const publishGate = evaluatePublishGate({
    unique_sources_count: numSources,
    total_usable_text_len: totalUsableTextLen,
    key_facts_count: keyFactsCount,
    overview_status: overviewStatus,
    has_disclaimer: false,
    topic_key: topicResult.topic_key,
    topic_confidence: topicResult.topic_confidence,
    allowed_topics: feedAllowedTopics.length > 0 ? feedAllowedTopics : undefined,
    importance_score: importanceScore,
  });
  const eligibilityReasons: string[] = [];
  if (!publishGate.eligible) {
    for (const r of publishGate.reasons) eligibilityReasons.push(`GATE:${r}`);
  }

  return {
    title: version?.headline ?? null,
    status: event.state,
    publishAt: event.publishAt?.toISOString() ?? null,
    updatedAt: event.tLast?.toISOString() ?? null,
    coverage: {
      num_articles: articles.length,
      num_sources_unique: numSources,
      sources,
    },
    coherence_gate: coherenceGate ? {
      status: coherenceGate.status ?? null,
      metrics: coherenceGate.metrics ?? null,
    } : null,
    quality_flags: {
      split_proxy: splitResult.split_proxy,
      split_proxy_detail: splitResult.split_proxy ? {
        top_topic: splitResult.top_topic,
        reasons: splitResult.reasons,
      } : null,
    },
    ranking_features: packet.ranking_features ?? null,
    topic_key: topicResult.topic_key,
    topic_confidence: Math.round(topicResult.topic_confidence * 1000) / 1000,
    topic_signals: topicResult.topic_signals ?? [],
    topic_reason: topicResult.topic_reason ?? null,
    importance_score: importanceScore,
    demotion_multiplier: demotion.multiplier,
    demotion_reasons: demotion.reasons,
    representative_article: repArt ? {
      url: repArt.url,
      mediaKey: repArt.media?.mediaKey ?? null,
      text_len: repArt.textContentLen ?? 0,
      page_type: repArt.contentType ?? null,
      blocked_reason: repArt.blockedReason ?? null,
      desk: repDeskResult.desk,
      desk_source: repDeskResult.desk_source,
    } : null,
    eligibility: {
      feed_eligible: eligibilityReasons.length === 0,
      reasons: eligibilityReasons,
    },
  };
}

// ── Commands ─────────────────────────────────────────────────────

async function cmdLabel(
  prisma: PrismaClient,
  flags: Record<string, string>,
): Promise<any[]> {
  const eventId = flags['event_id'];
  if (!eventId || !UUID_RE.test(eventId)) {
    return [{ kind: 'error', error: 'Missing or invalid --event_id (UUID required)' }];
  }

  const label = (flags['label'] ?? '').toUpperCase();
  const validation = validateLabelInput({ label, note: flags['note'] });
  if (!validation.valid) {
    return [{ kind: 'error', error: validation.error }];
  }

  const doSnapshot = flags['snapshot'] !== '0';
  const snapshotJson = doSnapshot ? await buildSnapshot(prisma, eventId) : {};

  const created = await prisma.eventLabel.create({
    data: {
      eventId,
      label,
      note: flags['note'] ?? null,
      gitSha: gitSha(),
      snapshotJson: snapshotJson as any,
    },
  });

  return [{
    kind: 'label',
    id: created.id,
    event_id: created.eventId,
    label: created.label,
    note: created.note,
    git_sha: created.gitSha,
    created_at: created.createdAt.toISOString(),
    snapshot_keys: Object.keys(snapshotJson),
  }];
}

async function cmdUnlabel(
  prisma: PrismaClient,
  flags: Record<string, string>,
): Promise<any[]> {
  const eventId = flags['event_id'];
  if (!eventId || !UUID_RE.test(eventId)) {
    return [{ kind: 'error', error: 'Missing or invalid --event_id (UUID required)' }];
  }

  if (flags['all'] === '1') {
    const result = await prisma.eventLabel.deleteMany({ where: { eventId } });
    return [{ kind: 'unlabel', event_id: eventId, deleted_count: result.count }];
  }

  // Delete only the most recent label
  const latest = await prisma.eventLabel.findFirst({
    where: { eventId },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) {
    return [{ kind: 'unlabel', event_id: eventId, deleted_count: 0, message: 'no labels found' }];
  }
  await prisma.eventLabel.delete({ where: { id: latest.id } });
  return [{ kind: 'unlabel', event_id: eventId, deleted_count: 1, deleted_id: latest.id }];
}

async function cmdList(
  prisma: PrismaClient,
  flags: Record<string, string>,
): Promise<any[]> {
  const limit = parseInt(flags['limit'] ?? '50', 10);
  const sinceHours = parseInt(flags['sinceHours'] ?? '168', 10);
  const labelFilter = flags['label']?.toUpperCase();

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

  return rows.map((r) => ({
    kind: 'label' as const,
    id: r.id,
    event_id: r.eventId,
    label: r.label,
    note: r.note,
    git_sha: r.gitSha,
    created_at: r.createdAt.toISOString(),
    has_snapshot: Object.keys((r.snapshotJson as any) ?? {}).length > 0,
  }));
}

async function cmdStats(
  prisma: PrismaClient,
  _flags: Record<string, string>,
): Promise<any[]> {
  const rows = await prisma.eventLabel.groupBy({
    by: ['label'],
    _count: true,
    orderBy: { _count: { label: 'desc' } },
  });

  const total = rows.reduce((sum, r) => sum + r._count, 0);
  const counts = rows.map((r) => ({ label: r.label, count: r._count }));

  // Top notes from BAD_OTHER
  const badOtherNotes = await prisma.eventLabel.findMany({
    where: { label: 'BAD_OTHER' },
    select: { note: true },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
  const noteCounts: Record<string, number> = {};
  for (const r of badOtherNotes) {
    if (r.note) {
      noteCounts[r.note] = (noteCounts[r.note] ?? 0) + 1;
    }
  }
  const topNotes = Object.entries(noteCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([note, count]) => ({ note, count }));

  return [{
    kind: 'stats' as const,
    total,
    counts,
    top_notes: topNotes,
  }];
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const { command, flags } = parseArgs(process.argv);
  const format = (flags['format'] ?? 'ndjson') as 'json' | 'ndjson' | 'table';

  const prisma = new PrismaClient();

  let output: any[];
  switch (command) {
    case 'label':
      output = await cmdLabel(prisma, flags);
      break;
    case 'unlabel':
      output = await cmdUnlabel(prisma, flags);
      break;
    case 'list':
      output = await cmdList(prisma, flags);
      break;
    case 'stats':
      output = await cmdStats(prisma, flags);
      break;
    default:
      output = [{
        kind: 'error',
        error: `Unknown command "${command}". Valid: label, unlabel, list, stats`,
        usage: [
          'npm run debug:events:label -- label   --event_id=<uuid> --label=GOOD',
          'npm run debug:events:label -- label   --event_id=<uuid> --label=BAD_OTHER --note="texto"',
          'npm run debug:events:label -- unlabel --event_id=<uuid>',
          'npm run debug:events:label -- list    --limit=50',
          'npm run debug:events:label -- stats',
        ],
      }];
  }

  process.stdout.write(formatOutput(output, format));
  await prisma.$disconnect();
}

// Guard: only run when invoked directly (not when imported by tests)
const isDirectRun = process.argv[1]?.endsWith('events-label.ts') || process.argv[1]?.endsWith('events-label.js');
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`events-label error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
