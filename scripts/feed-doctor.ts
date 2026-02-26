#!/usr/bin/env tsx
/**
 * Feed Doctor — CLI audit of all PUBLISHED events.
 *
 * Outputs NDJSON (1 line per record): run_meta, event*, aggregate.
 * Reuses runtime gate logic (publish gate, institutional gate, coherence gate).
 *
 * Usage:
 *   npm run debug:feed:doctor -- --hours=24 --limit=50
 *   npm run debug:feed:doctor -- --out=/tmp/feed_doctor.ndjson
 *   npm run debug:feed:doctor -- --include_text_samples=1 --format=json
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { evaluatePublishGate } from '../src/core/llm/gates.js';
import { isInstitutionalEvent } from '../src/modules/feed/service/feed-service.js';
import { computeEventScore, type EventForScoring } from '../src/modules/ranking/service/event-scorer.js';

// ── CLI args ────────────────────────────────────────────────────

export function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

// ── Helpers ─────────────────────────────────────────────────────

function gitSha(): string {
  try { return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim(); }
  catch { return 'unknown'; }
}

export function dbMeta(url: string): { host: string; name: string } {
  try {
    const u = new URL(url);
    return { host: u.host, name: u.pathname.replace(/^\//, '').split('?')[0] };
  } catch { return { host: 'unknown', name: 'unknown' }; }
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, i)];
}

export function bucketKey(n: number): string {
  if (n <= 2) return String(n);
  if (n <= 4) return '3-4';
  if (n <= 9) return '5-9';
  return '10+';
}

// ── Config ──────────────────────────────────────────────────────

export interface DoctorConfig {
  limit: number;
  hours: number;
  format: 'json' | 'ndjson';
  includeArticles: boolean;
  includeTextSamples: boolean;
  minArticles: number;
  minSources: number;
}

export function configFromArgs(args: Record<string, string>): DoctorConfig {
  return {
    limit: parseInt(args['limit'] ?? '200', 10),
    hours: parseInt(args['hours'] ?? '24', 10),
    format: (args['format'] ?? 'ndjson') as 'json' | 'ndjson',
    includeArticles: args['include_articles'] !== '0',
    includeTextSamples: args['include_text_samples'] === '1',
    minArticles: parseInt(args['min_articles'] ?? '1', 10),
    minSources: parseInt(args['min_sources'] ?? '1', 10),
  };
}

// ── Core processing (testable without Prisma) ───────────────────

export interface LinkerLog {
  entityId: string;
  action: string;
  data: any;
}

export function buildDoctorOutput(
  events: any[],
  linkerLogs: LinkerLog[],
  config: DoctorConfig,
  now: Date = new Date(),
): any[] {
  const db = dbMeta(process.env.DATABASE_URL ?? '');

  const runMeta = {
    kind: 'run_meta' as const,
    time_iso: now.toISOString(),
    git_sha: gitSha(),
    node_version: process.version,
    db_host: db.host,
    db_name: db.name,
    env: {
      PUBLISH_DELAY_MS: process.env.PUBLISH_DELAY_MS ?? '300000',
      SCHEDULER_TICK_MS: process.env.SCHEDULER_TICK_MS ?? '30000',
      COHERENCE_GATE_ENABLED: process.env.COHERENCE_GATE_ENABLED ?? '1',
      COHERENCE_EMBEDDING_COHESION_THRESHOLD: process.env.COHERENCE_EMBEDDING_COHESION_THRESHOLD ?? '0.60',
      COHERENCE_ENTITY_OVERLAP_THRESHOLD: process.env.COHERENCE_ENTITY_OVERLAP_THRESHOLD ?? '0.06',
      COHERENCE_TITLE_ALIGNMENT_THRESHOLD: process.env.COHERENCE_TITLE_ALIGNMENT_THRESHOLD ?? '0.10',
      COHERENCE_TOPIC_DRIFT_THRESHOLD: process.env.COHERENCE_TOPIC_DRIFT_THRESHOLD ?? '0.09',
      PUBLISH_GATE_ENABLED: process.env.PUBLISH_GATE_ENABLED ?? '1',
      GATE_MULTI_SOURCES: process.env.GATE_MULTI_SOURCES ?? '2',
      GATE_MULTI_TEXT: process.env.GATE_MULTI_TEXT ?? '1200',
      GATE_SINGLE_TEXT: process.env.GATE_SINGLE_TEXT ?? '800',
      THETA_AUTO_LINK: process.env.THETA_AUTO_LINK ?? '0.45',
      THETA_MAYBE_LINK: process.env.THETA_MAYBE_LINK ?? '0.30',
    },
    params: {
      limit: config.limit,
      hours: config.hours,
      format: config.format,
      include_articles: config.includeArticles,
      include_text_samples: config.includeTextSamples,
      min_articles: config.minArticles,
      min_sources: config.minSources,
    },
  };

  // Group linker decisions by event
  const linkerByEvent = new Map<string, LinkerLog[]>();
  for (const log of linkerLogs) {
    const list = linkerByEvent.get(log.entityId) ?? [];
    list.push(log);
    linkerByEvent.set(log.entityId, list);
  }

  const output: any[] = [runMeta];

  // Aggregate accumulators
  let feedEligible = 0;
  let feedIneligible = 0;
  const binsArticles: Record<string, number> = {};
  const binsSources: Record<string, number> = {};
  const cohesionValues: number[] = [];
  const entityOverlapValues: number[] = [];
  const topicDriftValues: number[] = [];
  const ineligibleReasons: Record<string, number> = {};
  const contentTypeCounts: Record<string, number> = {};

  for (const ev of events) {
    const articles = ev.eventArticles.map((ea: any) => ea.article);
    const version = ev.versions[0] ?? null;
    const packet: any = version?.packetJson ?? {};

    // ── Coverage ──
    const mediaMap = new Map<string, number>();
    for (const a of articles) {
      const key = a.media?.mediaKey ?? 'unknown';
      mediaMap.set(key, (mediaMap.get(key) ?? 0) + 1);
    }
    const numSources = mediaMap.size;
    const numArticles = articles.length;

    // Filter by min_articles / min_sources
    if (numArticles < config.minArticles || numSources < config.minSources) continue;

    const sources = [...mediaMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([mediaKey, count]) => ({ mediaKey, count }));

    // Momentum: articles in last 6h / 24h (by createdAt of eventArticle)
    const now6h = now.getTime() - 6 * 60 * 60 * 1000;
    const now24h = now.getTime() - 24 * 60 * 60 * 1000;
    const momentum6h = ev.eventArticles.filter((ea: any) => ea.createdAt.getTime() >= now6h).length;
    const momentum24h = ev.eventArticles.filter((ea: any) => ea.createdAt.getTime() >= now24h).length;

    // ── Topics ──
    const topicKeys: string[] = Array.isArray(packet.topic_keys) ? packet.topic_keys : [];
    const topicScores: Record<string, number> = packet.topic_scores ?? {};
    const top5 = Object.entries(topicScores)
      .sort((a, b) => (b[1] as number) - (a[1] as number))
      .slice(0, 5)
      .map(([topic, score]) => ({ topic, score }));

    // ── Routing / content_type breakdown ──
    const ctBreakdown: Record<string, number> = {};
    for (const a of articles) {
      const ct = a.contentType ?? 'unknown';
      ctBreakdown[ct] = (ctBreakdown[ct] ?? 0) + 1;
      contentTypeCounts[ct] = (contentTypeCounts[ct] ?? 0) + 1;
    }

    // Representative article: longest text, prefer NEWS
    const sortedArts = [...articles].sort((a: any, b: any) => {
      const aCt = a.contentType === 'news' ? 0 : 1;
      const bCt = b.contentType === 'news' ? 0 : 1;
      if (aCt !== bCt) return aCt - bCt;
      return (b.textContentLen ?? 0) - (a.textContentLen ?? 0);
    });
    const repArt = sortedArts[0];

    // ── Eligibility ──
    const reasons: string[] = [];

    // Coherence gate
    const coherenceGate = packet.coherence_gate ?? null;
    const coherenceStatus: string = coherenceGate?.status ?? 'NA';
    const coherenceMetrics = coherenceGate?.metrics ?? {};

    if (coherenceStatus === 'FAIL') {
      reasons.push('COHERENCE_FAIL');
      const failedChecks: string[] = coherenceGate?.failed_checks ?? [];
      for (const fc of failedChecks) reasons.push(`COHERENCE:${fc}`);
    }

    // Institutional gate (reuse runtime)
    const instCheck = isInstitutionalEvent(ev);
    if (instCheck.excluded) {
      reasons.push(`INSTITUTIONAL:${instCheck.reason}`);
    }

    // Publish gate (reuse runtime)
    const usableArticles = articles.filter((a: any) => a.usableForOverview);
    const totalUsableTextLen = usableArticles.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0);
    const keyFactsCount: number = packet.key_facts_count ?? 0;
    const overviewStatus = packet.ai_overview ? 'ready' : 'pending';

    const publishGate = evaluatePublishGate({
      unique_sources_count: numSources,
      total_usable_text_len: totalUsableTextLen,
      key_facts_count: keyFactsCount,
      overview_status: overviewStatus,
      has_disclaimer: false,
    });
    if (!publishGate.eligible) {
      for (const r of publishGate.reasons) reasons.push(`GATE:${r}`);
    }

    const eligible = reasons.length === 0;
    if (eligible) feedEligible++; else feedIneligible++;

    for (const r of reasons) {
      ineligibleReasons[r] = (ineligibleReasons[r] ?? 0) + 1;
    }

    // ── Ranking features ──
    const eventForScoring: EventForScoring = {
      id: ev.id,
      publishedAt: ev.publishedAt,
      tLast: ev.tLast,
      t0: ev.t0,
      articles: articles.map((a: any) => ({
        id: a.id, url: a.url, title: a.title, snippet: a.snippet,
        mediaId: a.media?.id ?? '', publishedAt: null, createdAt: new Date(),
      })),
      headline: version?.headline ?? null,
      topicKeys,
      claims: [],
    };
    const scored = computeEventScore(eventForScoring, now);

    // ── Linker summary ──
    const logs = linkerByEvent.get(ev.id) ?? [];
    const autoLinks = logs.filter((l) => l.action === 'AUTO_LINK').length;
    const maybeLinks = logs.filter((l) => l.action === 'MAYBE_LINK').length;
    const hardNegBlocks = logs.filter((l) => l.action === 'HARD_NEGATIVE_BLOCK').length;
    const splitActions = logs.filter((l) => l.action === 'SPLIT').length;
    const topReasons = logs
      .flatMap((l) => {
        const d = l.data as any;
        return Array.isArray(d?.reasons) ? d.reasons : (d?.reason ? [d.reason] : []);
      })
      .reduce((acc, r) => { acc[r] = (acc[r] ?? 0) + 1; return acc; }, {} as Record<string, number>);
    const topReasonsArr = Object.entries(topReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([r]) => r);

    // ── Coherence accumulators ──
    if (coherenceMetrics.avg_cosine != null) cohesionValues.push(coherenceMetrics.avg_cosine);
    if (coherenceMetrics.entity_jaccard != null) entityOverlapValues.push(coherenceMetrics.entity_jaccard);
    if (coherenceMetrics.stddev_drift != null) topicDriftValues.push(coherenceMetrics.stddev_drift);

    // ── Bins ──
    const artBin = bucketKey(numArticles);
    binsArticles[artBin] = (binsArticles[artBin] ?? 0) + 1;
    const srcBin = bucketKey(numSources);
    binsSources[srcBin] = (binsSources[srcBin] ?? 0) + 1;

    // ── Build event record ──
    const record: any = {
      kind: 'event',
      event_id: ev.id,
      title: version?.headline ?? null,
      status: ev.state,
      publishAt: ev.publishAt?.toISOString() ?? null,
      updatedAt: ev.tLast?.toISOString() ?? null,
      coverage: {
        num_articles: numArticles,
        num_sources_unique: numSources,
        sources,
        momentum_6h: momentum6h,
        momentum_24h: momentum24h,
      },
      topics: {
        top1: topicKeys[0] ?? null,
        top1_score: top5[0]?.score ?? null,
        top5,
      },
      routing: {
        content_type_breakdown: ctBreakdown,
        representative_article: repArt ? {
          article_id: repArt.id,
          url: repArt.url,
          mediaKey: repArt.media?.mediaKey ?? null,
          content_type: repArt.contentType ?? null,
          text_len: repArt.textContentLen ?? 0,
          title: repArt.title,
        } : null,
      },
      eligibility: {
        feed_eligible: eligible,
        reasons,
      },
      coherence_gate: {
        status: coherenceStatus,
        metrics: {
          cohesion: coherenceMetrics.avg_cosine ?? null,
          entity_overlap: coherenceMetrics.entity_jaccard ?? null,
          title_alignment: coherenceMetrics.title_jaccard ?? null,
          topic_drift: coherenceMetrics.stddev_drift ?? null,
          failed_checks_count: coherenceGate?.failed_checks?.length ?? 0,
        },
      },
      quality_flags: {
        mixed_event: null,
        boilerplate: null,
        split_proxy: null,
      },
      linker_summary: {
        auto_links: autoLinks,
        maybe_links: maybeLinks,
        hard_negative_blocks: hardNegBlocks,
        split_actions: splitActions,
        top_reasons: topReasonsArr,
      },
      ranking_features: {
        recency_score: scored.components.recency,
        coverage_score: scored.components.importance,
        diversity_score: scored.uniqueMediaCount,
        momentum_score: scored.components.momentum,
        topic_boost_score: scored.components.topicBoost,
        final_rank_score: scored.score,
      },
    };

    // Optional: articles
    if (config.includeArticles) {
      record.articles = articles.slice(0, 10).map((a: any) => ({
        article_id: a.id,
        url: a.url,
        mediaKey: a.media?.mediaKey ?? null,
        content_type: a.contentType ?? null,
        policy_status: a.status,
        text_len: a.textContentLen ?? 0,
        title: a.title,
      }));
    }

    // Optional: text samples
    if (config.includeTextSamples) {
      record.text_samples = {
        headline_snippet: (version?.headline ?? '').slice(0, 280),
        body_snippet: (articles[0]?.textNorm ?? '').slice(0, 280),
      };
    }

    output.push(record);
  }

  // ── aggregate ──
  cohesionValues.sort((a, b) => a - b);
  entityOverlapValues.sort((a, b) => a - b);
  topicDriftValues.sort((a, b) => a - b);

  const topIneligible = Object.entries(ineligibleReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([reason, count]) => ({ reason, count }));

  const topContentTypes = Object.entries(contentTypeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([content_type, count]) => ({ content_type, count }));

  const aggregate = {
    kind: 'aggregate' as const,
    totals: {
      events: events.length,
      events_published: events.length,
      feed_eligible: feedEligible,
      feed_ineligible: feedIneligible,
    },
    bins_articles: binsArticles,
    bins_sources: binsSources,
    coherence_percentiles: {
      cohesion: { p50: percentile(cohesionValues, 50), p75: percentile(cohesionValues, 75), p90: percentile(cohesionValues, 90) },
      entity_overlap: { p50: percentile(entityOverlapValues, 50), p75: percentile(entityOverlapValues, 75), p90: percentile(entityOverlapValues, 90) },
      topic_drift: { p50: percentile(topicDriftValues, 50), p75: percentile(topicDriftValues, 75), p90: percentile(topicDriftValues, 90) },
    },
    top_ineligible_reasons: topIneligible,
    top_content_types: topContentTypes,
  };
  output.push(aggregate);

  return output;
}

// ── Format output ──────────────────────────────────────────────

export function formatOutput(output: any[], format: 'json' | 'ndjson'): string {
  if (format === 'json') {
    return JSON.stringify(output, null, 2);
  }
  return output.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const cliArgs = parseArgs(process.argv);
  const config = configFromArgs(cliArgs);
  const OUT = cliArgs['out'] ?? '';

  const prisma = new PrismaClient();
  const now = new Date();
  const since = new Date(now.getTime() - config.hours * 60 * 60 * 1000);

  // ── Fetch events ──
  const events = await prisma.event.findMany({
    where: {
      state: 'PUBLISHED',
      canonicalEventId: null,
      publishedAt: { gte: since },
    },
    orderBy: { publishedAt: 'desc' },
    take: config.limit,
    include: {
      versions: { orderBy: { versionIndex: 'desc' as const }, take: 1 },
      eventArticles: {
        include: {
          article: {
            select: {
              id: true, url: true, title: true, snippet: true,
              textContentLen: true, textContentSource: true,
              usableForOverview: true, contentType: true,
              routingDecision: true, status: true,
              textNorm: config.includeTextSamples,
              media: { select: { id: true, mediaKey: true, name: true } },
            },
          },
        },
      },
    },
  });

  // ── Fetch audit log linker decisions (batch) ──
  const eventIds = events.map((e) => e.id);
  const linkerLogs = eventIds.length > 0
    ? await prisma.auditLog.findMany({
        where: {
          entityType: 'EVENT',
          entityId: { in: eventIds },
          action: { in: ['AUTO_LINK', 'MAYBE_LINK', 'CREATE', 'HARD_NEGATIVE_BLOCK', 'SPLIT'] },
        },
        select: { entityId: true, action: true, data: true },
      })
    : [];

  const output = buildDoctorOutput(events, linkerLogs, config, now);

  // ── Output ──
  const text = formatOutput(output, config.format);

  if (OUT) {
    writeFileSync(OUT, text, 'utf-8');
    process.stderr.write(`Wrote ${output.length} records to ${OUT}\n`);
  } else {
    process.stdout.write(text);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  process.stderr.write(`feed-doctor error: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
