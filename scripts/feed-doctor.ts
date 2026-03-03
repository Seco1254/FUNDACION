#!/usr/bin/env tsx
/**
 * Feed Doctor — CLI audit of events in the database.
 *
 * Outputs NDJSON (1 line per record): run_meta, event*, aggregate.
 * Reuses runtime gate logic (publish gate, institutional gate, coherence gate).
 *
 * Flags:
 *   --hours=0          All-time (default). >0 = only events within last N hours.
 *   --limit=200        Max events to process.
 *   --published_only=1 Only PUBLISHED events (default 0 = all states).
 *   --state=PUBLISHED  Explicit state filter (overrides --published_only).
 *   --format=ndjson    Output format: ndjson (default) or json.
 *   --out=/tmp/f.ndjson Write to file instead of stdout.
 *   --include_articles=1  Include article list per event (default 1).
 *   --include_text_samples=1  Include text snippets (default 0).
 *   --min_articles=N   Min articles per event (applied after time/state filter).
 *   --min_sources=N    Min unique sources per event (applied after time/state filter).
 *
 * Usage:
 *   npm run debug:feed:doctor                                     # all events, all-time
 *   npm run debug:feed:doctor -- --published_only=1 --limit=50    # only PUBLISHED
 *   npm run debug:feed:doctor -- --hours=24 --state=PUBLISHED     # last 24h, PUBLISHED
 *   npm run debug:feed:doctor -- --format=json --out=/tmp/doc.json
 */

import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { evaluatePublishGate, computeImportanceScore, computeDemotionMultiplier, computePublicImportanceV3 } from '../src/core/llm/gates.js';
import { readLifecycle, type OverviewLifecycle } from '../src/modules/overview/service/overview-lifecycle.js';
import { isInstitutionalEvent } from '../src/modules/feed/service/feed-service.js';
import { computeEventScore, type EventForScoring } from '../src/modules/ranking/service/event-scorer.js';
import { detectIntraSplitProxy } from '../src/modules/quality/detectors/intra-split-proxy.js';
import { aggregateEventTopic } from '../src/modules/topics/service/topic-heuristic.js';
import { extractDeskDetailed } from '../src/modules/event_linker/service/hard-negative-gates.js';

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

const VALID_STATES = ['DETECTED', 'PENDING_PUBLISH', 'PUBLISHED', 'UPDATING', 'DORMANT', 'CLOSED'] as const;
type EventStateName = (typeof VALID_STATES)[number];

export interface DoctorConfig {
  limit: number;
  /** 0 = all-time (no time filter), >0 = only events within last N hours */
  hours: number;
  format: 'json' | 'ndjson';
  includeArticles: boolean;
  includeTextSamples: boolean;
  minArticles: number;
  minSources: number;
  /** If true, only include PUBLISHED events (overridden by stateFilter) */
  publishedOnly: boolean;
  /** Explicit state filter; overrides publishedOnly when set */
  stateFilter: EventStateName | null;
}

export function configFromArgs(args: Record<string, string>): DoctorConfig {
  const stateRaw = args['state']?.toUpperCase() ?? null;
  const stateFilter = stateRaw && VALID_STATES.includes(stateRaw as EventStateName)
    ? (stateRaw as EventStateName)
    : null;

  return {
    limit: parseInt(args['limit'] ?? '200', 10),
    hours: parseInt(args['hours'] ?? '0', 10),
    format: (args['format'] ?? 'ndjson') as 'json' | 'ndjson',
    includeArticles: args['include_articles'] !== '0',
    includeTextSamples: args['include_text_samples'] === '1',
    minArticles: parseInt(args['min_articles'] ?? '1', 10),
    minSources: parseInt(args['min_sources'] ?? '1', 10),
    publishedOnly: args['published_only'] === '1',
    stateFilter,
  };
}

// ── v2.3: maybe_link_toxic rule ──────────────────────────────────

export interface MaybeLinkToxicInput {
  num_articles: number;
  split_proxy: boolean;
  coherence_status: string;
  maybe_link_degraded_total: number;
  maybe_link_degraded_by_reason: Record<string, number>;
}

/**
 * Conservative rule: mark an event as maybe_link_toxic when it has
 * too many MAYBE_LINK degradations caused by floor gates.
 *
 * Conditions (all must be true):
 *   1. num_articles >= 8
 *   2. split_proxy = true OR coherence_status = 'FAIL'
 *   3. maybe_link_degraded_total >= 5
 *   4. >= 60% of degradations are floor gates
 */
export function isMaybeLinkToxic(input: MaybeLinkToxicInput): boolean {
  if (input.num_articles < 8) return false;
  if (!input.split_proxy && input.coherence_status !== 'FAIL') return false;
  if (input.maybe_link_degraded_total < 5) return false;

  const floorCount =
    (input.maybe_link_degraded_by_reason['TITLE_ALIGNMENT_FLOOR'] ?? 0) +
    (input.maybe_link_degraded_by_reason['ENTITY_OVERLAP_FLOOR'] ?? 0);
  const floorPct = floorCount / input.maybe_link_degraded_total;
  return floorPct >= 0.6;
}

// ── Core processing (testable without Prisma) ───────────────────

export interface LinkerLog {
  entityId: string;
  action: string;
  data: any;
}

export interface PageTypeBlock {
  url: string;
  page_type: string;
  confidence: number;
  reasons: string[];
}

export interface DebugContext {
  total_events_in_db: number;
  total_published_in_db: number;
  applied_time_filter: string;
  applied_state_filter: string;
}

export function buildDoctorOutput(
  events: any[],
  linkerLogs: LinkerLog[],
  config: DoctorConfig,
  now: Date = new Date(),
  debugCtx?: DebugContext,
  pageTypeBlocks: PageTypeBlock[] = [],
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
      GATE_SINGLE_MIN_TEXT_LEN: process.env.GATE_SINGLE_MIN_TEXT_LEN ?? '1500',
      GATE_SINGLE_MIN_IMPORTANCE_SCORE: process.env.GATE_SINGLE_MIN_IMPORTANCE_SCORE ?? '0.45',
      GATE_SINGLE_TOPIC_CONFIDENCE_MIN: process.env.GATE_SINGLE_TOPIC_CONFIDENCE_MIN ?? '0.6',
      THETA_AUTO_LINK: process.env.THETA_AUTO_LINK ?? '0.45',
      THETA_MAYBE_LINK: process.env.THETA_MAYBE_LINK ?? '0.30',
      FEED_SPLIT_PROXY_QUARANTINE_ENABLED: process.env.FEED_SPLIT_PROXY_QUARANTINE_ENABLED ?? '1',
      FEED_ALLOWED_TOPICS: process.env.FEED_ALLOWED_TOPICS ?? '',
    },
    params: {
      limit: config.limit,
      hours: config.hours,
      format: config.format,
      include_articles: config.includeArticles,
      include_text_samples: config.includeTextSamples,
      min_articles: config.minArticles,
      min_sources: config.minSources,
      published_only: config.publishedOnly,
      state_filter: config.stateFilter,
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
  let splitProxyCount = 0;
  const hardNegativeReasonCounts: Record<string, number> = {};
  const binsTopics: Record<string, number> = {};
  const binsDesks: Record<string, number> = {};
  const singleSourceBlockedByReason: Record<string, number> = {};
  const demotionReasonCounts: Record<string, number> = {};
  const binsDeskSource: Record<string, number> = {};
  let lowTopicConfidenceCount = 0;
  let deskNullCount = 0;
  let maybeLinkDegradedTotal = 0;
  const maybeLinkDegradedByReason: Record<string, number> = {};
  let maybeLinkToxicCount = 0;
  // v3 aggregate accumulators
  const v3ScoresByTopic: Record<string, number[]> = {};
  let topicFirstPromotionCount = 0;
  // Overview lifecycle accumulators
  const binsOverviewStatus: Record<string, number> = {};
  let eligibleButNotReadyCount = 0;
  const overviewFailReasons: Record<string, number> = {};

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

    // Topic classification (v2: multi-article voting, same as feed-service)
    const headline = version?.headline ?? '';
    const aiWhText = Array.isArray(packet.ai_overview?.what_happened)
      ? packet.ai_overview.what_happened.join(' ')
      : '';
    const articleInputs = articles.map((a: any) => ({
      title: a.title ?? null,
      url: a.url ?? null,
      contentType: a.contentType ?? null,
    }));
    const topicResult = aggregateEventTopic(headline, articleInputs, aiWhText || null);
    const eventTopicKey = topicResult.topic_key;
    const eventTopicConfidence = topicResult.topic_confidence;

    // Desk extraction from representative article (with source tracking)
    const repDeskResult = repArt ? extractDeskDetailed(repArt.url) : { desk: null, desk_source: 'none' as const };
    const repDesk = repDeskResult.desk;
    const repDeskSource = repDeskResult.desk_source;

    // Importance score (v2)
    const hoursAge = ev.publishedAt
      ? (now.getTime() - new Date(ev.publishedAt).getTime()) / (3600 * 1000)
      : null;
    const eventImportanceScore = computeImportanceScore({
      topic_key: eventTopicKey,
      text_len: totalUsableTextLen,
      hours_since_published: hoursAge,
      unique_sources_count: numSources,
    });

    // FEED_ALLOWED_TOPICS from env (same as feed-service)
    const feedAllowedTopics: string[] = (process.env.FEED_ALLOWED_TOPICS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);

    const publishGate = evaluatePublishGate({
      unique_sources_count: numSources,
      total_usable_text_len: totalUsableTextLen,
      key_facts_count: keyFactsCount,
      overview_status: overviewStatus,
      has_disclaimer: false,
      topic_key: eventTopicKey,
      topic_confidence: eventTopicConfidence,
      allowed_topics: feedAllowedTopics.length > 0 ? feedAllowedTopics : undefined,
      importance_score: eventImportanceScore,
    });
    if (!publishGate.eligible) {
      for (const r of publishGate.reasons) reasons.push(`GATE:${r}`);
    }

    const eligible = reasons.length === 0;
    if (eligible) feedEligible++; else feedIneligible++;

    // Track single-source blocked reasons
    if (!eligible && numSources < 2) {
      for (const r of reasons) {
        singleSourceBlockedByReason[r] = (singleSourceBlockedByReason[r] ?? 0) + 1;
      }
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

    // Accumulate hard negative reasons for aggregate
    for (const [reason, count] of Object.entries(topReasons)) {
      hardNegativeReasonCounts[reason] = (hardNegativeReasonCounts[reason] ?? 0) + (count as number);
    }

    // v2.3: Per-event maybe_link_degraded stats
    const degradedLogs = logs.filter((l) => l.action === 'MAYBE_LINK_DEGRADED');
    const eventDegradedTotal = degradedLogs.length;
    const eventDegradedByReason: Record<string, number> = {};
    for (const dl of degradedLogs) {
      const reasons = Array.isArray(dl.data?.reasons) ? dl.data.reasons : [];
      for (const r of reasons) {
        eventDegradedByReason[r] = (eventDegradedByReason[r] ?? 0) + 1;
      }
    }
    // Accumulate to global
    maybeLinkDegradedTotal += eventDegradedTotal;
    for (const [r, c] of Object.entries(eventDegradedByReason)) {
      maybeLinkDegradedByReason[r] = (maybeLinkDegradedByReason[r] ?? 0) + c;
    }

    // v2.3: Compute split_proxy + maybe_link_toxic before demotion
    const splitResult = detectIntraSplitProxy(
      articles.map((a: any) => ({
        title: a.title ?? null,
        url: a.url ?? null,
        contentType: a.contentType ?? null,
      })),
    );
    if (splitResult.split_proxy) splitProxyCount++;

    const eventToxic = isMaybeLinkToxic({
      num_articles: numArticles,
      split_proxy: splitResult.split_proxy,
      coherence_status: coherenceStatus,
      maybe_link_degraded_total: eventDegradedTotal,
      maybe_link_degraded_by_reason: eventDegradedByReason,
    });
    if (eventToxic) maybeLinkToxicCount++;

    // Demotion multiplier (v2, with v2.3 toxic demotion)
    const demotion = computeDemotionMultiplier({
      unique_sources_count: numSources,
      topic_confidence: eventTopicConfidence,
      topic_key: eventTopicKey,
      total_usable_text_len: totalUsableTextLen,
      maybe_link_toxic: eventToxic,
    });
    for (const dr of demotion.reasons) {
      demotionReasonCounts[dr] = (demotionReasonCounts[dr] ?? 0) + 1;
    }

    // v3 topic-first ranking
    const v3 = computePublicImportanceV3({
      topic_key: eventTopicKey,
      topic_confidence: eventTopicConfidence,
      num_sources_unique: numSources,
      num_articles: numArticles,
      momentum_6h: momentum6h,
      demotion_multiplier: demotion.multiplier,
    });
    // Accumulate v3 scores by topic for aggregate
    const topicScoresArr = v3ScoresByTopic[eventTopicKey] ?? [];
    topicScoresArr.push(v3.final);
    v3ScoresByTopic[eventTopicKey] = topicScoresArr;
    // Detect topic-first promotion: event with low v1 importance but high v3 score
    if (v3.final > 0.40 && eventImportanceScore < 0.50) {
      topicFirstPromotionCount++;
    }

    // Overview lifecycle status
    const overviewLc = readLifecycle(packet);
    binsOverviewStatus[overviewLc.status] = (binsOverviewStatus[overviewLc.status] ?? 0) + 1;
    if (eligible && overviewLc.status !== 'READY') {
      eligibleButNotReadyCount++;
    }
    if (overviewLc.status === 'FAILED' && overviewLc.fail_reason) {
      overviewFailReasons[overviewLc.fail_reason] = (overviewFailReasons[overviewLc.fail_reason] ?? 0) + 1;
    }
    if (overviewLc.status === 'SKIPPED' && overviewLc.skip_reason) {
      overviewFailReasons[overviewLc.skip_reason] = (overviewFailReasons[overviewLc.skip_reason] ?? 0) + 1;
    }

    // Gate trace: record which checks were applied
    const gateTrace: string[] = [];
    if (coherenceStatus === 'FAIL') gateTrace.push('COHERENCE_GATE:BLOCKED');
    else if (coherenceStatus === 'PASS') gateTrace.push('COHERENCE_GATE:PASS');
    if (instCheck.excluded) gateTrace.push(`INSTITUTIONAL:BLOCKED(${instCheck.reason})`);
    else gateTrace.push('INSTITUTIONAL:PASS');
    gateTrace.push(`PUBLISH_GATE:${publishGate.eligible ? `PASS(${publishGate.gate_name ?? 'none'})` : `BLOCKED(${publishGate.reasons.join(',')})`}`);
    if (demotion.reasons.length > 0) gateTrace.push(`DEMOTION:${demotion.reasons.join(',')}`);

    // Reason summary
    let reasonSummary: string;
    if (eligible && publishGate.gate_name === 'multi') {
      reasonSummary = 'ENTRÓ POR: multi_source';
    } else if (eligible && publishGate.gate_name === 'single') {
      reasonSummary = `ENTRÓ POR: single_source score=${eventImportanceScore}`;
    } else if (!eligible) {
      reasonSummary = `BLOQUEADO POR: ${reasons.join(', ')}`;
    } else {
      reasonSummary = 'ENTRÓ POR: gate_disabled';
    }

    for (const r of reasons) {
      ineligibleReasons[r] = (ineligibleReasons[r] ?? 0) + 1;
    }

    // ── Coherence accumulators ──
    if (coherenceMetrics.avg_cosine != null) cohesionValues.push(coherenceMetrics.avg_cosine);
    if (coherenceMetrics.entity_jaccard != null) entityOverlapValues.push(coherenceMetrics.entity_jaccard);
    if (coherenceMetrics.stddev_drift != null) topicDriftValues.push(coherenceMetrics.stddev_drift);

    // ── Bins ──
    const artBin = bucketKey(numArticles);
    binsArticles[artBin] = (binsArticles[artBin] ?? 0) + 1;
    const srcBin = bucketKey(numSources);
    binsSources[srcBin] = (binsSources[srcBin] ?? 0) + 1;
    binsTopics[eventTopicKey] = (binsTopics[eventTopicKey] ?? 0) + 1;
    const deskBin = repDesk ?? 'unknown';
    binsDesks[deskBin] = (binsDesks[deskBin] ?? 0) + 1;
    binsDeskSource[repDeskSource] = (binsDeskSource[repDeskSource] ?? 0) + 1;
    if (eventTopicConfidence < 0.6) lowTopicConfidenceCount++;
    if (repDesk === null) deskNullCount++;

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
          page_type: (repArt.contentType === 'institutional_static' || repArt.contentType === 'institutional') ? repArt.contentType : 'ARTICLE',
          desk: repDesk,
          desk_source: repDeskSource,
          text_len: repArt.textContentLen ?? 0,
          title: repArt.title,
        } : null,
        topic_key: eventTopicKey,
        topic_confidence: Math.round(eventTopicConfidence * 1000) / 1000,
        topic_signals: topicResult.topic_signals ?? [],
        topic_reason: topicResult.topic_reason ?? null,
        importance_score: eventImportanceScore,
      },
      eligibility: {
        feed_eligible: eligible,
        reasons,
        gate_trace: gateTrace,
        reason_summary: reasonSummary,
      },
      demotion: {
        multiplier: demotion.multiplier,
        reasons: demotion.reasons,
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
      overview_lifecycle: {
        status: overviewLc.status,
        attempts: overviewLc.attempts,
        requested_at: overviewLc.requested_at,
        ready_at: overviewLc.ready_at,
        failed_at: overviewLc.failed_at,
        fail_reason: overviewLc.fail_reason,
        skip_reason: overviewLc.skip_reason,
      },
      quality_flags: {
        mixed_event: null,
        boilerplate: null,
        split_proxy: splitResult.split_proxy,
        split_proxy_detail: splitResult.split_proxy ? {
          top_topic: splitResult.top_topic,
          top_topic_share: splitResult.top_topic_share,
          top_desk: splitResult.top_desk,
          top_desk_share: splitResult.top_desk_share,
          reasons: splitResult.reasons,
        } : null,
        maybe_link_toxic: eventToxic,
      },
      linker_summary: {
        auto_links: autoLinks,
        maybe_links: maybeLinks,
        hard_negative_blocks: hardNegBlocks,
        split_actions: splitActions,
        top_reasons: topReasonsArr,
      },
      linker_stats: {
        maybe_link_degraded_total: eventDegradedTotal,
        maybe_link_degraded_by_reason: eventDegradedByReason,
      },
      ranking_features: {
        recency_score: scored.components.recency,
        coverage_score: scored.components.importance,
        diversity_score: scored.uniqueMediaCount,
        momentum_score: scored.components.momentum,
        topic_boost_score: scored.components.topicBoost,
        final_rank_score: scored.score,
        public_importance_v3_raw: v3.raw,
        public_importance_v3_final: v3.final,
        public_importance_v3_components: v3.components,
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
        blocked_reason: a.blockedReason ?? null,
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

  // Assign rank_position to event records sorted by v3 final score desc
  const eventRecords = output.filter((r) => r.kind === 'event');
  const sortedByV3 = [...eventRecords].sort(
    (a, b) => (b.ranking_features?.public_importance_v3_final ?? 0) - (a.ranking_features?.public_importance_v3_final ?? 0),
  );
  for (let i = 0; i < sortedByV3.length; i++) {
    sortedByV3[i].ranking_features.rank_position = i + 1;
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

  const eventsEmitted = output.length - 1; // minus run_meta
  const eventsPublished = events.filter((e) => e.state === 'PUBLISHED').length;

  const aggregate: any = {
    kind: 'aggregate' as const,
    totals: {
      events_fetched: events.length,
      events_published: eventsPublished,
      events_emitted: eventsEmitted,
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
    split_proxy_count: splitProxyCount,
    top_hard_negative_reasons: Object.entries(hardNegativeReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    bins_topics: Object.entries(binsTopics)
      .sort((a, b) => b[1] - a[1])
      .map(([topic, count]) => ({ topic, count })),
    bins_desks: Object.entries(binsDesks)
      .sort((a, b) => b[1] - a[1])
      .map(([desk, count]) => ({ desk, count })),
    single_source_blocked_by_reason: Object.entries(singleSourceBlockedByReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    top_demotion_reasons: Object.entries(demotionReasonCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    bins_desk_source: Object.entries(binsDeskSource)
      .sort((a, b) => b[1] - a[1])
      .map(([source, count]) => ({ source, count })),
    low_topic_confidence_count: lowTopicConfidenceCount,
    desk_null_count: deskNullCount,
    maybe_link_degraded_total: maybeLinkDegradedTotal,
    maybe_link_degraded_by_reason: Object.entries(maybeLinkDegradedByReason)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    maybe_link_toxic_count: maybeLinkToxicCount,
    // v3 topic-first ranking aggregate
    top_topics_by_rank: Object.entries(v3ScoresByTopic)
      .map(([topic, scores]) => ({
        topic,
        count: scores.length,
        avg_v3_final: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000,
      }))
      .sort((a, b) => b.avg_v3_final - a.avg_v3_final)
      .slice(0, 10),
    avg_public_importance_v3_by_topic: Object.entries(v3ScoresByTopic)
      .map(([topic, scores]) => ({
        topic,
        avg: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 1000) / 1000,
      }))
      .sort((a, b) => b.avg - a.avg),
    count_topic_first_promotions: topicFirstPromotionCount,
    // Overview lifecycle aggregate
    bins_overview_status: Object.entries(binsOverviewStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([status, count]) => ({ status, count })),
    eligible_but_not_ready_count: eligibleButNotReadyCount,
    overview_fail_reasons_top: Object.entries(overviewFailReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([reason, count]) => ({ reason, count })),
    what_to_fix_next: (() => {
      // Heuristic: suggest the highest-impact fix
      const suggestions: string[] = [];
      const totalEvents = events.length;
      if (totalEvents === 0) return suggestions;
      const singleSourcePct = (binsSources['1'] ?? 0) / totalEvents;
      if (singleSourcePct > 0.5) suggestions.push('HIGH_SINGLE_SOURCE_RATIO: >50% events have 1 source — improve crawl breadth');
      const blockedEntries = Object.entries(singleSourceBlockedByReason).sort((a, b) => b[1] - a[1]);
      if (blockedEntries.length > 0) {
        suggestions.push(`TOP_SINGLE_BLOCK: ${blockedEntries[0][0]} (${blockedEntries[0][1]} events)`);
      }
      const topDemotion = Object.entries(demotionReasonCounts).sort((a, b) => b[1] - a[1]);
      if (topDemotion.length > 0) {
        suggestions.push(`TOP_DEMOTION: ${topDemotion[0][0]} (${topDemotion[0][1]} events)`);
      }
      if (splitProxyCount > 0) {
        suggestions.push(`SPLIT_PROXY: ${splitProxyCount} events with mixed topics — review linker thresholds`);
      }
      return suggestions;
    })(),
    linker_accounting: (() => {
      let mergesAttempted = 0;
      let mergesApplied = 0;
      let hardNegativeBlocksTotal = 0;
      const mergeBlockReasons: Record<string, number> = {};
      for (const log of linkerLogs) {
        if (log.action === 'MERGED_EVENT_V2' || log.action === 'MERGED_EVENT') {
          mergesApplied++;
        }
        if (log.action === 'LINKED_EXISTING_V2' || log.action === 'CREATED_EVENT_V2') {
          mergesAttempted++;
        }
        if (log.action === 'HARD_NEGATIVE_BLOCK') {
          hardNegativeBlocksTotal++;
          const reasons = Array.isArray(log.data?.reasons)
            ? log.data.reasons
            : (log.data?.reason ? [log.data.reason] : []);
          for (const r of reasons) {
            mergeBlockReasons[r] = (mergeBlockReasons[r] ?? 0) + 1;
          }
        }
      }
      return {
        merges_attempted: mergesAttempted,
        merges_applied: mergesApplied,
        hard_negative_blocks_total: hardNegativeBlocksTotal,
        merge_block_reasons: Object.entries(mergeBlockReasons)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([reason, count]) => ({ reason, count })),
      };
    })(),
  };

  // Page-type blocking summary (from audit logs)
  if (pageTypeBlocks.length > 0) {
    const byType: Record<string, number> = {};
    for (const b of pageTypeBlocks) {
      byType[b.page_type] = (byType[b.page_type] ?? 0) + 1;
    }
    // Deduplicate: same URL may appear multiple times in audit logs across scrape runs
    const seen = new Set<string>();
    const unique = pageTypeBlocks.filter((b) => {
      if (seen.has(b.url)) return false;
      seen.add(b.url);
      return true;
    });
    const byTypeUnique: Record<string, number> = {};
    const samplesByType: Record<string, string[]> = {};
    for (const b of unique) {
      byTypeUnique[b.page_type] = (byTypeUnique[b.page_type] ?? 0) + 1;
      const list = samplesByType[b.page_type] ?? [];
      if (list.length < 3) list.push(b.url);
      samplesByType[b.page_type] = list;
    }
    aggregate.page_type_blocks = {
      total_audit_entries: pageTypeBlocks.length,
      unique_urls_blocked: unique.length,
      by_type: byTypeUnique,
      samples: samplesByType,
    };
  }

  if (debugCtx) {
    aggregate.debug = {
      ...debugCtx,
      min_articles: config.minArticles,
      min_sources: config.minSources,
    };
  }

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

  // ── Build where clause ──
  const where: any = { canonicalEventId: null };

  // State filter: --state overrides --published_only
  const effectiveState = config.stateFilter
    ?? (config.publishedOnly ? 'PUBLISHED' : null);
  if (effectiveState) {
    where.state = effectiveState;
  }

  // Time filter: hours=0 means all-time (no filter)
  let appliedTimeFilter = 'none (all-time)';
  if (config.hours > 0) {
    const since = new Date(now.getTime() - config.hours * 60 * 60 * 1000);
    where.createdAt = { gte: since };
    appliedTimeFilter = `createdAt >= ${since.toISOString()} (last ${config.hours}h)`;
  }

  // ── Fetch events ──
  const events = await prisma.event.findMany({
    where,
    orderBy: { createdAt: 'desc' },
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
              routingDecision: true, status: true, blockedReason: true,
              textNorm: config.includeTextSamples,
              media: { select: { id: true, mediaKey: true, name: true } },
            },
          },
        },
      },
    },
  });

  // ── Debug context (always fetched so aggregate is useful) ──
  const [totalEventsInDb, totalPublishedInDb] = await Promise.all([
    prisma.event.count({ where: { canonicalEventId: null } }),
    prisma.event.count({ where: { canonicalEventId: null, state: 'PUBLISHED' } }),
  ]);

  const debugCtx: DebugContext = {
    total_events_in_db: totalEventsInDb,
    total_published_in_db: totalPublishedInDb,
    applied_time_filter: appliedTimeFilter,
    applied_state_filter: effectiveState ?? 'none (all states)',
  };

  // ── Fetch audit log linker decisions (batch) ──
  const eventIds = events.map((e) => e.id);
  const linkerLogs = eventIds.length > 0
    ? await prisma.auditLog.findMany({
        where: {
          entityType: 'EVENT',
          entityId: { in: eventIds },
          action: { in: ['AUTO_LINK', 'MAYBE_LINK', 'CREATE', 'HARD_NEGATIVE_BLOCK', 'SPLIT', 'MAYBE_LINK_DEGRADED'] },
        },
        select: { entityId: true, action: true, data: true },
      })
    : [];

  // ── Fetch page-type blocking audit entries ──
  const pageTypeAudits = await prisma.auditLog.findMany({
    where: { action: 'PAGE_TYPE_BLOCKED' },
    select: { entityId: true, data: true },
  });
  const pageTypeBlocks: PageTypeBlock[] = pageTypeAudits.map((a) => {
    const d = a.data as any;
    return {
      url: d?.url ?? a.entityId,
      page_type: d?.page_type ?? 'UNKNOWN',
      confidence: d?.confidence ?? 0,
      reasons: Array.isArray(d?.reasons) ? d.reasons : [],
    };
  });

  const output = buildDoctorOutput(events, linkerLogs, config, now, debugCtx, pageTypeBlocks);

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
