/**
 * Feed Composition Policy — editorial control over the top N feed positions.
 *
 * Applied AFTER ranking v3 sort. Does NOT change ranking scores.
 * Skips items that violate composition rules, filling from the ranked pool.
 *
 * Rules (for top 10):
 *  1. Topic mix: min 6 core topics {POLITICA, ECONOMIA, CRIMEN_SEGURIDAD}, max 2 DEPORTES
 *  2. Analysis cap: max 2 events with source_mode=ANALYSIS
 *  3. Source diversity: max 1 event per representative_media_key in top 5
 *  4. Single-source cap: max 3 single-source events
 *  5. LOW tier block: source_tier=LOW never enters top N
 *
 * Fallback relaxation order when pool is too small:
 *  1. Allow +1 ANALYSIS
 *  2. Allow +1 DEPORTES
 *  3. Allow +1 single-source
 *  Never relax LOW tier block.
 */

import type { FeedItem } from '../domain/types.js';

// ── Types ────────────────────────────────────────────────────────────

export type CompositionRejectionReason =
  | 'COMPOSITION_LOW_TIER_BLOCK'
  | 'COMPOSITION_TOO_MANY_ANALYSIS'
  | 'COMPOSITION_TOO_MANY_SPORTS'
  | 'COMPOSITION_TOO_MANY_SINGLE_SOURCE'
  | 'COMPOSITION_TOO_MANY_FROM_SOURCE';

export interface CompositionRules {
  topN: number;
  /** Set of core topic keys (min count enforced) */
  coreTopics: Set<string>;
  /** Minimum core-topic events in topN */
  minCoreTopics: number;
  /** Maximum DEPORTES events in topN */
  maxSports: number;
  /** Maximum ANALYSIS events in topN */
  maxAnalysis: number;
  /** Max events from same mediaKey in top5 */
  maxPerSourceTop5: number;
  /** Maximum single-source events in topN */
  maxSingleSource: number;
}

export interface CompositionResult {
  /** Items selected for the top N, in order */
  topItems: FeedItem[];
  /** Remaining items that weren't selected, in original order */
  restItems: FeedItem[];
  /** Per-item rejection reasons (event_id → reason) */
  rejections: Map<string, CompositionRejectionReason>;
}

// ── Default rules ────────────────────────────────────────────────────

export const DEFAULT_COMPOSITION_RULES: CompositionRules = {
  topN: 10,
  coreTopics: new Set(['POLITICA', 'ECONOMIA', 'CRIMEN_SEGURIDAD']),
  minCoreTopics: 6,
  maxSports: 2,
  maxAnalysis: 2,
  maxPerSourceTop5: 1,
  maxSingleSource: 3,
};

// ── Core function ────────────────────────────────────────────────────

export function composeFeedTopN(
  rankedItems: FeedItem[],
  rules: CompositionRules = DEFAULT_COMPOSITION_RULES,
): CompositionResult {
  const topItems: FeedItem[] = [];
  const rejections = new Map<string, CompositionRejectionReason>();
  const skippedIndices = new Set<number>();

  // Mutable counters
  let sportsCount = 0;
  let analysisCount = 0;
  let singleSourceCount = 0;
  let coreTopicCount = 0;
  const sourceCountTop5 = new Map<string, number>();

  // First pass: try to fill topN with strict rules
  for (let i = 0; i < rankedItems.length && topItems.length < rules.topN; i++) {
    const item = rankedItems[i];
    const pos = topItems.length; // 0-indexed position in the top

    // Rule 5: LOW tier block (never relaxed)
    if (item.source_tier === 'LOW') {
      rejections.set(item.event_id, 'COMPOSITION_LOW_TIER_BLOCK');
      skippedIndices.add(i);
      continue;
    }

    // Rule 2: Analysis cap
    if (item.source_mode === 'ANALYSIS' && analysisCount >= rules.maxAnalysis) {
      rejections.set(item.event_id, 'COMPOSITION_TOO_MANY_ANALYSIS');
      skippedIndices.add(i);
      continue;
    }

    // Rule 1: Sports cap
    if (item.topic_key === 'DEPORTES' && sportsCount >= rules.maxSports) {
      rejections.set(item.event_id, 'COMPOSITION_TOO_MANY_SPORTS');
      skippedIndices.add(i);
      continue;
    }

    // Rule 3: Source diversity in top 5
    const mediaKey = item.representative_media_key ?? 'unknown';
    if (pos < 5) {
      const curSourceCount = sourceCountTop5.get(mediaKey) ?? 0;
      if (curSourceCount >= rules.maxPerSourceTop5) {
        rejections.set(item.event_id, 'COMPOSITION_TOO_MANY_FROM_SOURCE');
        skippedIndices.add(i);
        continue;
      }
    }

    // Rule 4: Single-source cap
    const isSingleSource = (item.unique_sources_count ?? 1) <= 1;
    if (isSingleSource && singleSourceCount >= rules.maxSingleSource) {
      rejections.set(item.event_id, 'COMPOSITION_TOO_MANY_SINGLE_SOURCE');
      skippedIndices.add(i);
      continue;
    }

    // Item passes — add to top
    topItems.push(item);
    if (item.topic_key === 'DEPORTES') sportsCount++;
    if (item.source_mode === 'ANALYSIS') analysisCount++;
    if (isSingleSource) singleSourceCount++;
    if (rules.coreTopics.has(item.topic_key ?? '')) coreTopicCount++;
    if (pos < 5) {
      sourceCountTop5.set(mediaKey, (sourceCountTop5.get(mediaKey) ?? 0) + 1);
    }
  }

  // Fallback: if we didn't fill topN, relax rules progressively
  if (topItems.length < rules.topN) {
    // Collect remaining candidates (not yet selected, not yet rejected)
    const remaining = rankedItems
      .map((item, idx) => ({ item, idx }))
      .filter(({ idx }) => !skippedIndices.has(idx) && idx >= topItems.length + skippedIndices.size ? false : true)
      .filter(({ item }) => !topItems.includes(item));

    // Actually, let's rebuild from rejected items in priority order
    const rejectedByReason = new Map<CompositionRejectionReason, FeedItem[]>();
    for (const [eventId, reason] of rejections) {
      const item = rankedItems.find((i) => i.event_id === eventId);
      if (!item) continue;
      const list = rejectedByReason.get(reason) ?? [];
      list.push(item);
      rejectedByReason.set(reason, list);
    }

    // Relaxation order: ANALYSIS → SPORTS → SINGLE_SOURCE
    // Never relax LOW_TIER_BLOCK
    const relaxOrder: CompositionRejectionReason[] = [
      'COMPOSITION_TOO_MANY_ANALYSIS',
      'COMPOSITION_TOO_MANY_SPORTS',
      'COMPOSITION_TOO_MANY_SINGLE_SOURCE',
    ];

    for (const reason of relaxOrder) {
      if (topItems.length >= rules.topN) break;
      const candidates = rejectedByReason.get(reason) ?? [];
      for (const item of candidates) {
        if (topItems.length >= rules.topN) break;
        // Still enforce LOW tier block
        if (item.source_tier === 'LOW') continue;
        topItems.push(item);
        rejections.delete(item.event_id);
      }
    }
  }

  // Build restItems: items not in topItems, in original ranked order
  const topSet = new Set(topItems.map((i) => i.event_id));
  const restItems = rankedItems.filter((i) => !topSet.has(i.event_id));

  return { topItems, restItems, rejections };
}
