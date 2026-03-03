#!/usr/bin/env tsx
/**
 * Labels Session CLI — list recent events for a labeling session.
 *
 * Shows unlabeled (or all) PUBLISHED events ready for human review.
 *
 * Usage:
 *   npm run debug:labels:session
 *   npm run debug:labels:session -- --hours=24 --limit=10
 *   npm run debug:labels:session -- --format=ndjson
 *   npm run debug:labels:session -- --publishedOnly=0
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { aggregateEventTopic } from '../src/modules/topics/service/topic-heuristic.js';

// ── Config ───────────────────────────────────────────────────────

export interface SessionConfig {
  hours: number;
  limit: number;
  publishedOnly: boolean;
  format: 'table' | 'ndjson';
}

export function parseSessionArgs(argv: string[]): SessionConfig {
  const flags: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
  }
  return {
    hours: parseInt(flags['hours'] ?? '6', 10),
    limit: parseInt(flags['limit'] ?? '20', 10),
    publishedOnly: flags['publishedOnly'] !== '0',
    format: (flags['format'] === 'ndjson' ? 'ndjson' : 'table') as 'table' | 'ndjson',
  };
}

// ── Row shape ────────────────────────────────────────────────────

export interface SessionRow {
  event_id: string;
  event_id_short: string;
  title: string | null;
  topic_key: string | null;
  topic_confidence: number | null;
  num_articles: number;
  num_sources_unique: number;
  rep_url: string | null;
  publishAt: string | null;
}

// ── Build rows from DB events ────────────────────────────────────

export function buildSessionRow(event: any): SessionRow {
  const articles = (event.eventArticles ?? []).map((ea: any) => ea.article);
  const version = event.versions?.[0] ?? null;
  const packet: any = version?.packetJson ?? {};

  // Coverage
  const mediaKeys = new Set<string>();
  for (const a of articles) {
    mediaKeys.add(a.media?.mediaKey ?? 'unknown');
  }

  // Topic (recompute like feed-doctor)
  const headline = version?.headline ?? '';
  const aiWhText = Array.isArray(packet.ai_overview?.what_happened)
    ? packet.ai_overview.what_happened.join(' ')
    : '';
  const articleInputs = articles.map((a: any) => ({
    title: a.title ?? null, url: a.url ?? null, contentType: a.contentType ?? null,
  }));
  const topicResult = aggregateEventTopic(headline, articleInputs, aiWhText || null);

  // Representative article: longest text, prefer news
  const sortedArts = [...articles].sort((a: any, b: any) => {
    const aCt = a.contentType === 'news' ? 0 : 1;
    const bCt = b.contentType === 'news' ? 0 : 1;
    if (aCt !== bCt) return aCt - bCt;
    return (b.textContentLen ?? 0) - (a.textContentLen ?? 0);
  });
  const repUrl = sortedArts[0]?.url ?? null;

  return {
    event_id: event.id,
    event_id_short: event.id.slice(0, 8),
    title: version?.headline ?? null,
    topic_key: topicResult.topic_key,
    topic_confidence: Math.round(topicResult.topic_confidence * 1000) / 1000,
    num_articles: articles.length,
    num_sources_unique: mediaKeys.size,
    rep_url: repUrl,
    publishAt: event.publishAt?.toISOString() ?? null,
  };
}

// ── Formatters ───────────────────────────────────────────────────

export function formatSessionTable(rows: SessionRow[]): string {
  if (rows.length === 0) return '(no events found)\n';

  const header = [
    'event_id'.padEnd(10),
    'title'.padEnd(80),
    'topic'.padEnd(18),
    'conf'.padStart(5),
    'arts'.padStart(4),
    'srcs'.padStart(4),
    'rep_url',
  ].join('  ');

  const sep = '─'.repeat(header.length);

  const lines = rows.map((r) => {
    const title = (r.title ?? '').slice(0, 80).padEnd(80);
    const topic = (r.topic_key ?? '').padEnd(18);
    const conf = r.topic_confidence != null ? r.topic_confidence.toFixed(2).padStart(5) : '    ?';
    const arts = String(r.num_articles).padStart(4);
    const srcs = String(r.num_sources_unique).padStart(4);
    return [
      `${r.event_id_short}…`.padEnd(10),
      title,
      topic,
      conf,
      arts,
      srcs,
      r.rep_url ?? '',
    ].join('  ');
  });

  return [sep, header, sep, ...lines, sep, `${rows.length} events`, ''].join('\n');
}

export function formatSessionNdjson(rows: SessionRow[]): string {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

export function formatSessionOutput(rows: SessionRow[], format: 'table' | 'ndjson'): string {
  if (format === 'ndjson') return formatSessionNdjson(rows);
  return formatSessionTable(rows);
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const config = parseSessionArgs(process.argv);
  const prisma = new PrismaClient();

  const where: any = { canonicalEventId: null };
  if (config.publishedOnly) {
    where.state = 'PUBLISHED';
  }
  if (config.hours > 0) {
    const since = new Date(Date.now() - config.hours * 60 * 60 * 1000);
    where.publishAt = { gte: since };
  }

  const events = await prisma.event.findMany({
    where,
    orderBy: { publishAt: 'desc' },
    take: config.limit,
    include: {
      versions: { orderBy: { versionIndex: 'desc' as const }, take: 1 },
      eventArticles: {
        include: {
          article: {
            select: {
              id: true, url: true, title: true,
              textContentLen: true, contentType: true,
              media: { select: { mediaKey: true } },
            },
          },
        },
      },
    },
  });

  const rows = events.map(buildSessionRow);
  process.stdout.write(formatSessionOutput(rows, config.format));
  await prisma.$disconnect();
}

const isDirectRun = process.argv[1]?.endsWith('labels-session.ts') || process.argv[1]?.endsWith('labels-session.js');
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`labels-session error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
