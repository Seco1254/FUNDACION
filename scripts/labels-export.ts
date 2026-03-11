#!/usr/bin/env tsx
/**
 * Labels Export CLI — export labeled events + features as NDJSON or CSV.
 *
 * Usage:
 *   npm run debug:labels:export
 *   npm run debug:labels:export -- --format=csv --latestOnly=1
 *   npm run debug:labels:export -- --label=BAD_MERGE --includeArticles=1
 *   npm run debug:labels:export -- --format=csv --publishedOnly=0
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';

// ── CSV column order (stable contract) ───────────────────────────

export const CSV_COLUMNS = [
  'event_id',
  'label',
  'note',
  'label_created_at',
  'title',
  'publishAt',
  'num_articles',
  'num_sources_unique',
  'sources',
  'topic_key',
  'topic_confidence',
  'topic_reason',
  'topic_signals',
  'importance_score',
  'demotion_multiplier',
  'demotion_reasons',
  'coherence_status',
  'cohesion',
  'entity_overlap',
  'title_alignment',
  'topic_drift',
  'split_proxy',
  'split_proxy_reasons',
  'rep_url',
  'rep_mediaKey',
  'rep_text_len',
  'rep_page_type',
  'rep_desk',
  'rep_desk_source',
  'rep_blocked_reason',
  'eligibility_feed_eligible',
  'eligibility_reasons',
] as const;

// ── CLI arg parsing ──────────────────────────────────────────────

export interface ExportConfig {
  sinceHours: number;
  limit: number;
  format: 'ndjson' | 'csv';
  latestOnly: boolean;
  includeArticles: boolean;
  label: string | null;
  publishedOnly: boolean;
}

export function parseExportArgs(argv: string[]): ExportConfig {
  const flags: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) flags[m[1]] = m[2];
  }
  return {
    sinceHours: parseInt(flags['sinceHours'] ?? '168', 10),
    limit: parseInt(flags['limit'] ?? '5000', 10),
    format: (flags['format'] === 'csv' ? 'csv' : 'ndjson') as 'ndjson' | 'csv',
    latestOnly: flags['latestOnly'] !== '0',
    includeArticles: flags['includeArticles'] === '1',
    label: flags['label']?.toUpperCase() ?? null,
    publishedOnly: flags['publishedOnly'] !== '0',
  };
}

// ── Compact string helpers ───────────────────────────────────────

/** "eltiempo:3|razon_publica:1" */
export function compactSources(sources: Array<{ mediaKey: string; count: number }> | null | undefined): string {
  if (!sources || sources.length === 0) return '';
  return sources.map((s) => `${s.mediaKey}:${s.count}`).join('|');
}

/** "CO_KW:gobierno|URL_HINT:/politica/" — max 5 */
export function compactSignals(signals: string[] | null | undefined): string {
  if (!signals || signals.length === 0) return '';
  return signals.slice(0, 5).join('|');
}

/** "SINGLE_SOURCE|LOW_TOPIC_CONFIDENCE" */
export function compactReasons(reasons: string[] | null | undefined): string {
  if (!reasons || reasons.length === 0) return '';
  return reasons.join('|');
}

// ── Snapshot → flat row ──────────────────────────────────────────

export interface ExportRow {
  event_id: string;
  label: string;
  note: string | null;
  label_created_at: string;
  title: string | null;
  publishAt: string | null;
  num_articles: number | null;
  num_sources_unique: number | null;
  sources: string;
  topic_key: string | null;
  topic_confidence: number | null;
  topic_reason: string | null;
  topic_signals: string;
  importance_score: number | null;
  demotion_multiplier: number | null;
  demotion_reasons: string;
  coherence_status: string | null;
  cohesion: number | null;
  entity_overlap: number | null;
  title_alignment: number | null;
  topic_drift: number | null;
  split_proxy: boolean | null;
  split_proxy_reasons: string;
  rep_url: string | null;
  rep_mediaKey: string | null;
  rep_text_len: number | null;
  rep_page_type: string | null;
  rep_desk: string | null;
  rep_desk_source: string | null;
  rep_blocked_reason: string | null;
  eligibility_feed_eligible: boolean | null;
  eligibility_reasons: string;
  articles_sample?: string;
}

export function flattenLabel(row: {
  eventId: string;
  label: string;
  note: string | null;
  createdAt: Date;
  snapshotJson: any;
}, includeArticles: boolean): ExportRow {
  const s = (row.snapshotJson ?? {}) as any;
  const cov = s.coverage ?? {};
  const coh = s.coherence_gate ?? {};
  const cohMetrics = coh.metrics ?? {};
  const rep = s.representative_article ?? {};
  const elig = s.eligibility ?? {};
  const qf = s.quality_flags ?? {};
  const spd = qf.split_proxy_detail ?? {};

  const flat: ExportRow = {
    event_id: row.eventId,
    label: row.label,
    note: row.note ?? null,
    label_created_at: row.createdAt.toISOString(),
    title: s.title ?? null,
    publishAt: s.publishAt ?? null,
    num_articles: cov.num_articles ?? null,
    num_sources_unique: cov.num_sources_unique ?? null,
    sources: compactSources(cov.sources),
    topic_key: s.topic_key ?? null,
    topic_confidence: s.topic_confidence ?? null,
    topic_reason: s.topic_reason ?? null,
    topic_signals: compactSignals(s.topic_signals),
    importance_score: s.importance_score ?? null,
    demotion_multiplier: s.demotion_multiplier ?? null,
    demotion_reasons: compactReasons(s.demotion_reasons),
    coherence_status: coh.status ?? null,
    cohesion: cohMetrics.avg_cosine ?? cohMetrics.cohesion ?? null,
    entity_overlap: cohMetrics.entity_jaccard ?? cohMetrics.entity_overlap ?? null,
    title_alignment: cohMetrics.title_jaccard ?? cohMetrics.title_alignment ?? null,
    topic_drift: cohMetrics.stddev_drift ?? cohMetrics.topic_drift ?? null,
    split_proxy: qf.split_proxy ?? null,
    split_proxy_reasons: compactReasons(spd.reasons),
    rep_url: rep.url ?? null,
    rep_mediaKey: rep.mediaKey ?? null,
    rep_text_len: rep.text_len ?? null,
    rep_page_type: rep.page_type ?? null,
    rep_desk: rep.desk ?? null,
    rep_desk_source: rep.desk_source ?? null,
    rep_blocked_reason: rep.blocked_reason ?? null,
    eligibility_feed_eligible: elig.feed_eligible ?? null,
    eligibility_reasons: compactReasons(elig.reasons),
  };

  if (includeArticles) {
    flat.articles_sample = compactArticlesSample(s);
  }

  return flat;
}

/** Build compact articles sample from snapshot coverage.sources as proxy.
 *  Real article detail isn't stored in snapshot, so we build from what we have.
 *  rep article is first, remaining sources fill out up to cap of 5. */
export function compactArticlesSample(snapshot: any): string {
  const rep = snapshot?.representative_article;
  const sources: Array<{ mediaKey: string; count: number }> = snapshot?.coverage?.sources ?? [];
  const items: string[] = [];

  // Representative article first
  if (rep?.url) {
    items.push(JSON.stringify({
      url: rep.url,
      mediaKey: rep.mediaKey ?? null,
      text_len: rep.text_len ?? null,
      page_type: rep.page_type ?? null,
      blocked_reason: rep.blocked_reason ?? null,
      desk: rep.desk ?? null,
    }));
  }

  // Fill remaining from sources (as summary entries, no full article data)
  for (const src of sources) {
    if (items.length >= 5) break;
    if (rep?.mediaKey && src.mediaKey === rep.mediaKey) continue; // skip rep's source
    items.push(JSON.stringify({
      url: null,
      mediaKey: src.mediaKey,
      text_len: null,
      page_type: null,
      blocked_reason: null,
      desk: null,
    }));
  }

  return `[${items.join(',')}]`;
}

// ── latestOnly dedup ─────────────────────────────────────────────

export function deduplicateLatest(rows: Array<{ eventId: string; createdAt: Date; [k: string]: any }>): typeof rows {
  const seen = new Map<string, typeof rows[0]>();
  // Rows should already be ordered by createdAt DESC from DB,
  // but be defensive: keep the most recent per event_id.
  for (const r of rows) {
    const existing = seen.get(r.eventId);
    if (!existing || r.createdAt > existing.createdAt) {
      seen.set(r.eventId, r);
    }
  }
  return [...seen.values()];
}

// ── CSV formatter ────────────────────────────────────────────────

function escapeCsv(val: any): string {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatCsvHeader(includeArticles: boolean): string {
  const cols = [...CSV_COLUMNS];
  if (includeArticles) cols.push('articles_sample');
  return cols.join(',');
}

export function formatCsvRow(row: ExportRow, includeArticles: boolean): string {
  const cols = [...CSV_COLUMNS] as string[];
  if (includeArticles) cols.push('articles_sample');
  return cols.map((col) => escapeCsv((row as any)[col])).join(',');
}

export function formatExportOutput(rows: ExportRow[], config: ExportConfig): string {
  if (config.format === 'csv') {
    const header = formatCsvHeader(config.includeArticles);
    const lines = rows.map((r) => formatCsvRow(r, config.includeArticles));
    return [header, ...lines].join('\n') + '\n';
  }
  // NDJSON
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : '');
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  const config = parseExportArgs(process.argv);
  const prisma = new PrismaClient();

  // Build where clause
  const where: any = {};
  if (config.sinceHours > 0) {
    where.createdAt = { gte: new Date(Date.now() - config.sinceHours * 60 * 60 * 1000) };
  }
  if (config.label) {
    where.label = config.label;
  }

  // Fetch labels
  const labels = await prisma.eventLabel.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: config.limit,
  });

  // latestOnly dedup
  const deduplicated = config.latestOnly ? deduplicateLatest(labels as any) : labels;

  // publishedOnly filter: need to check Event.state
  let filtered = deduplicated;
  if (config.publishedOnly) {
    const eventIds = deduplicated.map((r: any) => r.eventId);
    if (eventIds.length > 0) {
      const publishedEvents = await prisma.event.findMany({
        where: { id: { in: eventIds }, state: 'PUBLISHED' },
        select: { id: true },
      });
      const publishedSet = new Set(publishedEvents.map((e) => e.id));
      filtered = deduplicated.filter((r: any) => publishedSet.has(r.eventId));
    }
  }

  // Flatten
  const rows = filtered.map((r: any) => flattenLabel(r, config.includeArticles));

  // Output
  process.stdout.write(formatExportOutput(rows, config));
  await prisma.$disconnect();
}

const isDirectRun = process.argv[1]?.endsWith('labels-export.ts') || process.argv[1]?.endsWith('labels-export.js');
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`labels-export error: ${err.message}\n${err.stack}\n`);
    process.exit(1);
  });
}
