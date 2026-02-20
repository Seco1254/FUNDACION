/**
 * Quality snapshot service — generates an aggregate quality report
 * for published events within a time window.
 *
 * Design: 1 big Prisma query, everything else computed in-memory.
 */
import { PrismaClient } from '@prisma/client';
import { logger } from '../../../core/logging/logger.js';
import { computeEvidenceLevel, EvidenceLevel } from '../../feed/service/evidence-level.js';
import { computeCentroid } from '../../event_linker/service/similarity.js';
import { extractEntities } from '../../event_linker/service/pair-scorer.js';
import { detectBoilerplate } from '../detectors/boilerplate.js';
import { detectMixedEvent } from '../detectors/mixed-event.js';
import { detectSplitPairs, EventForSplit, SplitPair } from '../detectors/split-proxy.js';
import {
  QUALITY_BOILERPLATE_ENABLED,
  QUALITY_MIXED_EVENT_ENABLED,
  QUALITY_MIXED_EVENT_MAX_COHESION,
  QUALITY_SPLIT_PROXY_ENABLED,
  QUALITY_SPLIT_PROXY_MIN_SIM,
  QUALITY_SPLIT_PROXY_MIN_ENTITY_OVERLAP,
} from '../config.js';

// ── Response types ──────────────────────────────────────────────

export interface Percentiles {
  p50: number;
  p75: number;
  p90: number;
  max: number;
}

export interface TopEventFlags {
  mixed_event_flag: boolean;
  boilerplate_flag: boolean;
  split_suspect_flag: boolean;
}

export interface TopEvent {
  event_id: string;
  headline: string | null;
  published_at: string | null;
  article_count: number;
  unique_media_count: number;
  evidence_level: EvidenceLevel;
  importance_score: number;
  flags: TopEventFlags;
  reasons: string[];
  sample_evidence: string[];
}

export interface QualitySnapshot {
  window: { from: string; to: string };
  aggregates: {
    published_events: number;
    boilerplate_rate: number;
    mixed_event_rate: number;
    split_proxy_rate: number;
    distributions: {
      unique_media_count: Percentiles;
      article_count: Percentiles;
      evidence_level: Record<string, number>;
    };
  };
  top_events: TopEvent[];
  split_pairs: SplitPair[];
  config: Record<string, unknown>;
}

// ── Helpers ─────────────────────────────────────────────────────

function computePercentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p75: 0, p90: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) =>
    sorted[Math.min(Math.floor(p * sorted.length), sorted.length - 1)];
  return {
    p50: at(0.5),
    p75: at(0.75),
    p90: at(0.9),
    max: sorted[sorted.length - 1],
  };
}

const MAX_EVENTS = 200;

// ── Service ─────────────────────────────────────────────────────

export class QualitySnapshotService {
  constructor(private prisma: PrismaClient) {}

  async generate(hours: number = 24): Promise<QualitySnapshot> {
    const startMs = Date.now();
    const to = new Date();
    const from = new Date(to.getTime() - hours * 60 * 60 * 1000);

    // ── 1 big query: published events + latest version + articles w/ embeddings ──
    const events = await this.prisma.event.findMany({
      where: {
        state: 'PUBLISHED' as any,
        publishedAt: { gte: from, lte: to },
        canonicalEventId: null,
      },
      include: {
        versions: {
          orderBy: { versionIndex: 'desc' as const },
          take: 1,
        },
        eventArticles: {
          include: {
            article: {
              select: {
                id: true,
                title: true,
                snippet: true,
                textContentLen: true,
                usableForOverview: true,
                embeddingVec: true,
                media: { select: { mediaKey: true } },
              },
            },
          },
        },
      },
      orderBy: { publishedAt: 'desc' },
      take: MAX_EVENTS,
    });

    // ── Per-event processing (single pass) ──
    const mediaCounts: number[] = [];
    const articleCounts: number[] = [];
    const evidenceCounts: Record<string, number> = { high: 0, medium: 0, low: 0, none: 0 };

    let totalBoilerplateBullets = 0;
    let matchedBoilerplateBullets = 0;
    let mixedCount = 0;

    const topEvents: TopEvent[] = [];
    const splitInputs: EventForSplit[] = [];
    const splitSuspects = new Set<string>();

    for (const evt of events) {
      const version = evt.versions[0] ?? null;
      const packet: any = version?.packetJson ?? {};
      const articles = evt.eventArticles.map((ea: any) => ea.article);

      const uniqueMediaKeys = new Set<string>(
        articles.map((a: any) => a.media?.mediaKey ?? 'unknown'),
      );
      const uniqueMediaCount = uniqueMediaKeys.size;
      const articleCount = articles.length;
      const usableArticles = articles.filter((a: any) => a.usableForOverview);
      const totalTextLen = usableArticles.reduce(
        (s: number, a: any) => s + (a.textContentLen ?? 0),
        0,
      );
      const evidenceLevel = computeEvidenceLevel(uniqueMediaCount, totalTextLen);

      mediaCounts.push(uniqueMediaCount);
      articleCounts.push(articleCount);
      evidenceCounts[evidenceLevel] = (evidenceCounts[evidenceLevel] ?? 0) + 1;

      // ── Boilerplate ──
      const ai = packet?.ai_overview;
      const bullets: string[] = [
        ...(Array.isArray(ai?.what_happened) ? ai.what_happened : []),
        ...(Array.isArray(ai?.context) ? ai.context : []),
        ...(Array.isArray(ai?.in_dispute) ? ai.in_dispute : []),
      ];
      const boilerplate = QUALITY_BOILERPLATE_ENABLED
        ? detectBoilerplate(bullets)
        : { rate: 0, total: 0, matched: 0, matched_samples: [] as string[] };
      totalBoilerplateBullets += boilerplate.total;
      matchedBoilerplateBullets += boilerplate.matched;

      // ── Mixed event ──
      const embeddings: number[][] = articles
        .map((a: any) => a.embeddingVec)
        .filter((v: unknown): v is number[] => Array.isArray(v) && v.length > 0);

      const mixed = QUALITY_MIXED_EVENT_ENABLED
        ? detectMixedEvent(embeddings, QUALITY_MIXED_EVENT_MAX_COHESION)
        : { mixed_event_flag: false, avg_pairwise_sim: 1, min_pairwise_sim: 1, pair_count: 0, reasons: [] as string[] };
      if (mixed.mixed_event_flag) mixedCount++;

      // ── Split-proxy input ──
      if (QUALITY_SPLIT_PROXY_ENABLED && embeddings.length > 0) {
        const centroid = computeCentroid(embeddings);
        const allText = articles
          .map((a: any) => `${a.title} ${a.snippet}`)
          .join(' ');
        splitInputs.push({
          event_id: evt.id,
          centroid,
          entities: extractEntities(allText),
        });
      }

      // ── Importance score ──
      const recencyMs = to.getTime() - (evt.publishedAt?.getTime() ?? to.getTime());
      const recencyBoost = Math.max(0, 1 - recencyMs / (hours * 60 * 60 * 1000));
      const importanceScore =
        Math.log(1 + articleCount) +
        Math.log(1 + uniqueMediaCount) +
        recencyBoost;

      // ── Sample evidence ──
      const sampleEvidence: string[] = [];
      if (Array.isArray(ai?.what_happened)) {
        sampleEvidence.push(...(ai.what_happened as string[]).slice(0, 2));
      }
      if (sampleEvidence.length < 2) {
        for (const a of articles.slice(0, 3 - sampleEvidence.length)) {
          sampleEvidence.push(a.title);
        }
      }

      // ── Flags & reasons ──
      const flags: TopEventFlags = {
        mixed_event_flag: mixed.mixed_event_flag,
        boilerplate_flag: boilerplate.rate > 0.3,
        split_suspect_flag: false, // filled after split detection
      };
      const reasons: string[] = [];
      if (mixed.mixed_event_flag) reasons.push(...mixed.reasons);
      if (flags.boilerplate_flag) {
        reasons.push(
          `boilerplate_rate=${boilerplate.rate.toFixed(2)} (${boilerplate.matched}/${boilerplate.total})`,
        );
      }

      topEvents.push({
        event_id: evt.id,
        headline: version?.headline ?? null,
        published_at: evt.publishedAt?.toISOString() ?? null,
        article_count: articleCount,
        unique_media_count: uniqueMediaCount,
        evidence_level: evidenceLevel,
        importance_score: importanceScore,
        flags,
        reasons,
        sample_evidence: sampleEvidence.slice(0, 3),
      });
    }

    // ── Split proxy detection (pairwise, O(n^2) but n<=200) ──
    const splitPairs = QUALITY_SPLIT_PROXY_ENABLED
      ? detectSplitPairs(
          splitInputs,
          QUALITY_SPLIT_PROXY_MIN_SIM,
          QUALITY_SPLIT_PROXY_MIN_ENTITY_OVERLAP,
        )
      : [];

    for (const pair of splitPairs) {
      splitSuspects.add(pair.event_a);
      splitSuspects.add(pair.event_b);
    }

    for (const evt of topEvents) {
      if (splitSuspects.has(evt.event_id)) {
        evt.flags.split_suspect_flag = true;
        const pair = splitPairs.find(
          (p) => p.event_a === evt.event_id || p.event_b === evt.event_id,
        );
        if (pair) {
          evt.reasons.push(
            `split_suspect: sim=${pair.centroid_sim.toFixed(3)} entity_overlap=${pair.entity_overlap.toFixed(3)}`,
          );
        }
      }
      evt.reasons = evt.reasons.slice(0, 5);
    }

    // ── Sort by importance, take top 20 ──
    topEvents.sort((a, b) => b.importance_score - a.importance_score);
    const top20 = topEvents.slice(0, 20);

    const durationMs = Date.now() - startMs;
    logger.info(
      {
        duration_ms: durationMs,
        published_events: events.length,
        mixed_count: mixedCount,
        split_pairs: splitPairs.length,
      },
      'quality_snapshot_generated',
    );

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      aggregates: {
        published_events: events.length,
        boilerplate_rate:
          totalBoilerplateBullets > 0
            ? matchedBoilerplateBullets / totalBoilerplateBullets
            : 0,
        mixed_event_rate:
          events.length > 0 ? mixedCount / events.length : 0,
        split_proxy_rate:
          events.length > 0 ? splitSuspects.size / events.length : 0,
        distributions: {
          unique_media_count: computePercentiles(mediaCounts),
          article_count: computePercentiles(articleCounts),
          evidence_level: evidenceCounts,
        },
      },
      top_events: top20,
      split_pairs: splitPairs,
      config: {
        boilerplate_enabled: QUALITY_BOILERPLATE_ENABLED,
        mixed_event_enabled: QUALITY_MIXED_EVENT_ENABLED,
        mixed_event_max_cohesion: QUALITY_MIXED_EVENT_MAX_COHESION,
        split_proxy_enabled: QUALITY_SPLIT_PROXY_ENABLED,
        split_proxy_min_sim: QUALITY_SPLIT_PROXY_MIN_SIM,
        split_proxy_min_entity_overlap: QUALITY_SPLIT_PROXY_MIN_ENTITY_OVERLAP,
        window_hours: hours,
      },
    };
  }
}
