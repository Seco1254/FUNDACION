import { describe, it, expect, beforeEach } from 'vitest';
import {
  composeFeedTopN,
  DEFAULT_COMPOSITION_RULES,
  type CompositionRules,
} from './feed-composition.js';
import type { FeedItem } from '../domain/types.js';

// ── Helpers ─────────────────────────────────────────────────────────

let idCounter = 0;
function makeItem(overrides: Partial<FeedItem> = {}): FeedItem {
  idCounter++;
  return {
    event_id: overrides.event_id ?? `evt-${idCounter}`,
    state: 'PUBLISHED',
    headline: overrides.headline ?? `Headline ${idCounter}`,
    t_last: null,
    published_at: null,
    cover_image_url: null,
    topic_key: overrides.topic_key ?? 'POLITICA',
    source_tier: overrides.source_tier ?? 'HIGH',
    source_mode: overrides.source_mode ?? 'NEWS',
    source_policy_multiplier: overrides.source_policy_multiplier ?? 1.0,
    representative_media_key: overrides.representative_media_key ?? `media-${idCounter}`,
    unique_sources_count: overrides.unique_sources_count ?? 3,
    public_importance_v3_final: overrides.public_importance_v3_final ?? (1 - idCounter * 0.01),
    ...overrides,
  };
}

function resetCounter() { idCounter = 0; }

function makeCoreTopicPool(count: number): FeedItem[] {
  const topics = ['POLITICA', 'ECONOMIA', 'CRIMEN_SEGURIDAD'];
  return Array.from({ length: count }, (_, i) =>
    makeItem({
      topic_key: topics[i % topics.length],
      representative_media_key: `media-core-${i}`,
    }),
  );
}

// ── Basic composition ───────────────────────────────────────────────

describe('composeFeedTopN', () => {
  beforeEach(() => resetCounter());

  it('returns up to topN items in topItems', () => {
    const items = makeCoreTopicPool(15);
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(10);
    expect(result.restItems.length).toBe(5);
  });

  it('preserves ranking order when no rules are violated', () => {
    const items = makeCoreTopicPool(12);
    const result = composeFeedTopN(items);
    for (let i = 1; i < result.topItems.length; i++) {
      expect(result.topItems[i - 1].public_importance_v3_final!)
        .toBeGreaterThanOrEqual(result.topItems[i].public_importance_v3_final!);
    }
  });

  it('handles fewer items than topN gracefully', () => {
    const items = makeCoreTopicPool(5);
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(5);
    expect(result.restItems.length).toBe(0);
  });

  it('handles empty input', () => {
    const result = composeFeedTopN([]);
    expect(result.topItems.length).toBe(0);
    expect(result.restItems.length).toBe(0);
    expect(result.rejections.size).toBe(0);
  });
});

// ── Rule 5: LOW tier block ──────────────────────────────────────────

describe('composeFeedTopN — LOW tier block', () => {
  beforeEach(() => resetCounter());

  it('LOW tier events never enter top 10', () => {
    const items = [
      makeItem({ source_tier: 'LOW', public_importance_v3_final: 0.99, topic_key: 'POLITICA' }),
      ...makeCoreTopicPool(12),
    ];
    const result = composeFeedTopN(items);
    const lowInTop = result.topItems.filter((i) => i.source_tier === 'LOW');
    expect(lowInTop.length).toBe(0);
  });

  it('LOW tier block is recorded as rejection', () => {
    const lowItem = makeItem({ event_id: 'evt-low', source_tier: 'LOW', topic_key: 'POLITICA' });
    const items = [lowItem, ...makeCoreTopicPool(12)];
    const result = composeFeedTopN(items);
    expect(result.rejections.get('evt-low')).toBe('COMPOSITION_LOW_TIER_BLOCK');
  });

  it('LOW tier block is never relaxed even with small corpus', () => {
    const items = [
      makeItem({ source_tier: 'LOW', topic_key: 'POLITICA' }),
      makeItem({ source_tier: 'LOW', topic_key: 'ECONOMIA' }),
    ];
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(0);
  });
});

// ── Rule 1: DEPORTES cap ────────────────────────────────────────────

describe('composeFeedTopN — DEPORTES cap', () => {
  beforeEach(() => resetCounter());

  it('max 2 DEPORTES in top 10', () => {
    const items = [
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd1' }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd2' }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd3' }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd4' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    const sportsInTop = result.topItems.filter((i) => i.topic_key === 'DEPORTES');
    expect(sportsInTop.length).toBeLessThanOrEqual(2);
  });

  it('3rd DEPORTES gets rejected with correct reason', () => {
    const items = [
      makeItem({ event_id: 'sp-1', topic_key: 'DEPORTES', representative_media_key: 'd1' }),
      makeItem({ event_id: 'sp-2', topic_key: 'DEPORTES', representative_media_key: 'd2' }),
      makeItem({ event_id: 'sp-3', topic_key: 'DEPORTES', representative_media_key: 'd3' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    expect(result.rejections.get('sp-3')).toBe('COMPOSITION_TOO_MANY_SPORTS');
  });
});

// ── Rule 2: ANALYSIS cap ────────────────────────────────────────────

describe('composeFeedTopN — ANALYSIS cap', () => {
  beforeEach(() => resetCounter());

  it('max 2 ANALYSIS in top 10', () => {
    const items = [
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'POLITICA', representative_media_key: 'a1' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'ECONOMIA', representative_media_key: 'a2' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'a3' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    const analysisInTop = result.topItems.filter((i) => i.source_mode === 'ANALYSIS');
    expect(analysisInTop.length).toBeLessThanOrEqual(2);
  });

  it('3rd ANALYSIS gets rejected', () => {
    const items = [
      makeItem({ event_id: 'an-1', source_mode: 'ANALYSIS', topic_key: 'POLITICA', representative_media_key: 'a1' }),
      makeItem({ event_id: 'an-2', source_mode: 'ANALYSIS', topic_key: 'ECONOMIA', representative_media_key: 'a2' }),
      makeItem({ event_id: 'an-3', source_mode: 'ANALYSIS', topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'a3' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    expect(result.rejections.get('an-3')).toBe('COMPOSITION_TOO_MANY_ANALYSIS');
  });
});

// ── Rule 3: Source diversity in top 5 ───────────────────────────────

describe('composeFeedTopN — source diversity top 5', () => {
  beforeEach(() => resetCounter());

  it('max 1 event per mediaKey in top 5', () => {
    const items = [
      makeItem({ event_id: 'et-1', representative_media_key: 'eltiempo', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'et-2', representative_media_key: 'eltiempo', topic_key: 'ECONOMIA' }),
      makeItem({ event_id: 'et-3', representative_media_key: 'eltiempo', topic_key: 'CRIMEN_SEGURIDAD' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    const top5 = result.topItems.slice(0, 5);
    const mediaCounts = new Map<string, number>();
    for (const item of top5) {
      const mk = item.representative_media_key ?? 'unknown';
      mediaCounts.set(mk, (mediaCounts.get(mk) ?? 0) + 1);
    }
    for (const count of mediaCounts.values()) {
      expect(count).toBeLessThanOrEqual(1);
    }
  });

  it('duplicate mediaKey in top 5 gets rejected', () => {
    const items = [
      makeItem({ event_id: 'et-1', representative_media_key: 'eltiempo', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'et-2', representative_media_key: 'eltiempo', topic_key: 'ECONOMIA' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    expect(result.rejections.get('et-2')).toBe('COMPOSITION_TOO_MANY_FROM_SOURCE');
  });

  it('same mediaKey allowed once in positions 6-10 (maxPerSourceTopN=2)', () => {
    // Each source appears exactly twice (pos 1-5 + pos 6-10) — within maxPerSourceTopN=2
    const items = [
      makeItem({ representative_media_key: 'src-1', topic_key: 'POLITICA' }),
      makeItem({ representative_media_key: 'src-2', topic_key: 'ECONOMIA' }),
      makeItem({ representative_media_key: 'src-3', topic_key: 'CRIMEN_SEGURIDAD' }),
      makeItem({ representative_media_key: 'src-4', topic_key: 'POLITICA' }),
      makeItem({ representative_media_key: 'src-5', topic_key: 'ECONOMIA' }),
      // Positions 6+ — 2nd occurrence of each source, still within cap of 2
      makeItem({ representative_media_key: 'src-1', topic_key: 'CRIMEN_SEGURIDAD' }),
      makeItem({ representative_media_key: 'src-2', topic_key: 'POLITICA' }),
      makeItem({ representative_media_key: 'src-3', topic_key: 'ECONOMIA' }),
      makeItem({ representative_media_key: 'src-4', topic_key: 'CRIMEN_SEGURIDAD' }),
      makeItem({ representative_media_key: 'src-5', topic_key: 'POLITICA' }),
    ];
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(10);
    expect(result.rejections.size).toBe(0);
  });
});

// ── Rule 3b: Per-source cap across full topN ─────────────────────────

describe('composeFeedTopN — per-source topN cap (maxPerSourceTopN=2)', () => {
  beforeEach(() => resetCounter());

  it('3rd item from same source is rejected from top 10', () => {
    const items = [
      makeItem({ event_id: 'et-1', representative_media_key: 'eltiempo', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'et-2', representative_media_key: 'eltiempo', topic_key: 'ECONOMIA' }),
      makeItem({ event_id: 'et-3', representative_media_key: 'eltiempo', topic_key: 'CRIMEN_SEGURIDAD' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    const eltiempoInTop = result.topItems.filter((i) => i.representative_media_key === 'eltiempo');
    expect(eltiempoInTop.length).toBeLessThanOrEqual(2);
    expect(result.rejections.get('et-3')).toBe('COMPOSITION_TOO_MANY_FROM_SOURCE');
  });

  it('2 items from same source are accepted (one in top-5, one in 6-10)', () => {
    // et-1 lands at position 0 (top-5). 4 different sources fill positions 1-4.
    // et-2 lands at position 5+ (past top-5 strict rule) → accepted under maxPerSourceTopN=2.
    const items = [
      makeItem({ event_id: 'et-1', representative_media_key: 'eltiempo', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'filler-1', representative_media_key: 'semana', topic_key: 'ECONOMIA' }),
      makeItem({ event_id: 'filler-2', representative_media_key: 'elespectador', topic_key: 'CRIMEN_SEGURIDAD' }),
      makeItem({ event_id: 'filler-3', representative_media_key: 'caracol', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'filler-4', representative_media_key: 'rcn', topic_key: 'ECONOMIA' }),
      makeItem({ event_id: 'et-2', representative_media_key: 'eltiempo', topic_key: 'CRIMEN_SEGURIDAD' }),
      ...makeCoreTopicPool(6),
    ];
    const result = composeFeedTopN(items);
    const eltiempoInTop = result.topItems.filter((i) => i.representative_media_key === 'eltiempo');
    expect(eltiempoInTop.length).toBe(2);
    expect(result.rejections.has('et-1')).toBe(false);
    expect(result.rejections.has('et-2')).toBe(false);
  });

  it('composition_reordered_count tracks per-source demotions', () => {
    const items = [
      makeItem({ event_id: 'et-1', representative_media_key: 'eltiempo', topic_key: 'POLITICA' }),
      makeItem({ event_id: 'et-2', representative_media_key: 'eltiempo', topic_key: 'ECONOMIA' }),
      makeItem({ event_id: 'et-3', representative_media_key: 'eltiempo', topic_key: 'CRIMEN_SEGURIDAD' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    // et-3 was bumped out due to per-source cap → reordered_count >= 1
    expect(result.composition_reordered_count).toBeGreaterThanOrEqual(1);
  });
});

// ── Rule 4: Single-source cap ───────────────────────────────────────

describe('composeFeedTopN — single-source cap', () => {
  beforeEach(() => resetCounter());

  it('max 3 single-source events in top 10', () => {
    const items = [
      makeItem({ unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'ss-1' }),
      makeItem({ unique_sources_count: 1, topic_key: 'ECONOMIA', representative_media_key: 'ss-2' }),
      makeItem({ unique_sources_count: 1, topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'ss-3' }),
      makeItem({ unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'ss-4' }),
      makeItem({ unique_sources_count: 1, topic_key: 'ECONOMIA', representative_media_key: 'ss-5' }),
      ...makeCoreTopicPool(8),
    ];
    const result = composeFeedTopN(items);
    const singleInTop = result.topItems.filter((i) => (i.unique_sources_count ?? 1) <= 1);
    expect(singleInTop.length).toBeLessThanOrEqual(3);
  });

  it('4th single-source gets rejected', () => {
    const items = [
      makeItem({ event_id: 'ss-1', unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'sm-1' }),
      makeItem({ event_id: 'ss-2', unique_sources_count: 1, topic_key: 'ECONOMIA', representative_media_key: 'sm-2' }),
      makeItem({ event_id: 'ss-3', unique_sources_count: 1, topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'sm-3' }),
      makeItem({ event_id: 'ss-4', unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'sm-4' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    expect(result.rejections.get('ss-4')).toBe('COMPOSITION_TOO_MANY_SINGLE_SOURCE');
  });
});

// ── Fallback relaxation ─────────────────────────────────────────────

describe('composeFeedTopN — fallback relaxation', () => {
  beforeEach(() => resetCounter());

  it('relaxes ANALYSIS cap when corpus is too small', () => {
    // 3 analysis + 5 core = 8, need 10 but only 8 available
    // Fallback should allow the 3rd analysis
    const items = [
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'POLITICA', representative_media_key: 'a1' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'ECONOMIA', representative_media_key: 'a2' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'a3' }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'c1' }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'c2' }),
      makeItem({ topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'c3' }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'c4' }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'c5' }),
    ];
    const result = composeFeedTopN(items);
    // Should have all 8 items (3 analysis + 5 regular) since fallback relaxes
    expect(result.topItems.length).toBe(8);
    const analysisInTop = result.topItems.filter((i) => i.source_mode === 'ANALYSIS');
    expect(analysisInTop.length).toBe(3);
  });

  it('relaxes DEPORTES cap when corpus is too small', () => {
    const items = [
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd1' }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd2' }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd3' }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'c1' }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'c2' }),
      makeItem({ topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'c3' }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'c4' }),
    ];
    const result = composeFeedTopN(items);
    const sportsInTop = result.topItems.filter((i) => i.topic_key === 'DEPORTES');
    expect(sportsInTop.length).toBe(3);
  });

  it('relaxes single-source cap when corpus is too small', () => {
    const items = [
      makeItem({ unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'ss-1' }),
      makeItem({ unique_sources_count: 1, topic_key: 'ECONOMIA', representative_media_key: 'ss-2' }),
      makeItem({ unique_sources_count: 1, topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'ss-3' }),
      makeItem({ unique_sources_count: 1, topic_key: 'POLITICA', representative_media_key: 'ss-4' }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'c1' }),
      makeItem({ topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'c2' }),
    ];
    const result = composeFeedTopN(items);
    const singleInTop = result.topItems.filter((i) => (i.unique_sources_count ?? 1) <= 1);
    expect(singleInTop.length).toBe(4); // relaxed from 3
  });

  it('never relaxes LOW tier block even with fallback', () => {
    const items = [
      makeItem({ source_tier: 'LOW', topic_key: 'POLITICA' }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'c1' }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'c2' }),
    ];
    const result = composeFeedTopN(items);
    expect(result.topItems.filter((i) => i.source_tier === 'LOW').length).toBe(0);
    expect(result.topItems.length).toBe(2);
  });
});

// ── Rest items preserved ────────────────────────────────────────────

describe('composeFeedTopN — rest items', () => {
  beforeEach(() => resetCounter());

  it('items beyond top 10 follow original ranking order', () => {
    const items = makeCoreTopicPool(20);
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(10);
    expect(result.restItems.length).toBe(10);
    // Rest items should be in original order (descending score)
    for (let i = 1; i < result.restItems.length; i++) {
      expect(result.restItems[i - 1].public_importance_v3_final!)
        .toBeGreaterThanOrEqual(result.restItems[i].public_importance_v3_final!);
    }
  });

  it('rejected items appear in restItems (not lost)', () => {
    const lowItem = makeItem({ event_id: 'evt-low', source_tier: 'LOW', topic_key: 'POLITICA' });
    const items = [lowItem, ...makeCoreTopicPool(12)];
    const result = composeFeedTopN(items);
    expect(result.restItems.find((i) => i.event_id === 'evt-low')).toBeDefined();
  });
});

// ── Custom rules ────────────────────────────────────────────────────

describe('composeFeedTopN — custom rules', () => {
  beforeEach(() => resetCounter());

  it('respects custom topN', () => {
    const items = makeCoreTopicPool(20);
    const result = composeFeedTopN(items, { ...DEFAULT_COMPOSITION_RULES, topN: 5 });
    expect(result.topItems.length).toBe(5);
    expect(result.restItems.length).toBe(15);
  });

  it('respects custom maxSports=0', () => {
    const items = [
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'd1' }),
      ...makeCoreTopicPool(12),
    ];
    const result = composeFeedTopN(items, { ...DEFAULT_COMPOSITION_RULES, maxSports: 0 });
    const sportsInTop = result.topItems.filter((i) => i.topic_key === 'DEPORTES');
    expect(sportsInTop.length).toBe(0);
  });

  it('respects custom maxAnalysis=0', () => {
    const items = [
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'POLITICA', representative_media_key: 'a1' }),
      ...makeCoreTopicPool(12),
    ];
    const result = composeFeedTopN(items, { ...DEFAULT_COMPOSITION_RULES, maxAnalysis: 0 });
    const analysisInTop = result.topItems.filter((i) => i.source_mode === 'ANALYSIS');
    expect(analysisInTop.length).toBe(0);
  });
});

// ── Combined rules ──────────────────────────────────────────────────

describe('composeFeedTopN — combined rules interaction', () => {
  beforeEach(() => resetCounter());

  it('handles event that is both ANALYSIS and DEPORTES', () => {
    // Analysis DEPORTES should be counted against both caps
    const items = [
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'DEPORTES', representative_media_key: 'ad1' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'DEPORTES', representative_media_key: 'ad2' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'DEPORTES', representative_media_key: 'ad3' }),
      ...makeCoreTopicPool(10),
    ];
    const result = composeFeedTopN(items);
    const analysisDeportesInTop = result.topItems.filter(
      (i) => i.source_mode === 'ANALYSIS' && i.topic_key === 'DEPORTES',
    );
    // Max 2 analysis OR max 2 sports — whichever hits first
    expect(analysisDeportesInTop.length).toBeLessThanOrEqual(2);
  });

  it('source diversity + single-source interact correctly', () => {
    const items = [
      makeItem({ unique_sources_count: 1, representative_media_key: 'src-a', topic_key: 'POLITICA' }),
      makeItem({ unique_sources_count: 1, representative_media_key: 'src-a', topic_key: 'ECONOMIA' }),
      ...makeCoreTopicPool(12),
    ];
    const result = composeFeedTopN(items);
    // 2nd item should be rejected for source diversity (both from src-a in top 5)
    const top5SrcA = result.topItems.slice(0, 5).filter((i) => i.representative_media_key === 'src-a');
    expect(top5SrcA.length).toBeLessThanOrEqual(1);
  });

  it('large realistic corpus selects well-mixed top 10', () => {
    resetCounter();
    const items: FeedItem[] = [
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'et', unique_sources_count: 5 }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'ee', unique_sources_count: 4 }),
      makeItem({ topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'rv', unique_sources_count: 3 }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'marca', unique_sources_count: 2 }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'semana', unique_sources_count: 4 }),
      makeItem({ topic_key: 'ECONOMIA', representative_media_key: 'portafolio', unique_sources_count: 3 }),
      makeItem({ topic_key: 'CRIMEN_SEGURIDAD', representative_media_key: 'bluradio', unique_sources_count: 2 }),
      makeItem({ topic_key: 'SALUD', representative_media_key: 'minsalud', unique_sources_count: 3 }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'espn', unique_sources_count: 2 }),
      makeItem({ topic_key: 'POLITICA', representative_media_key: 'caracol', unique_sources_count: 5 }),
      makeItem({ topic_key: 'DEPORTES', representative_media_key: 'futbolred', unique_sources_count: 2 }),
      makeItem({ source_tier: 'LOW', topic_key: 'POLITICA', representative_media_key: 'oec' }),
      makeItem({ source_mode: 'ANALYSIS', topic_key: 'ECONOMIA', representative_media_key: 'rp', unique_sources_count: 2 }),
    ];
    const result = composeFeedTopN(items);
    expect(result.topItems.length).toBe(10);

    // LOW tier should be excluded
    expect(result.topItems.filter((i) => i.source_tier === 'LOW').length).toBe(0);
    // Max 2 DEPORTES
    expect(result.topItems.filter((i) => i.topic_key === 'DEPORTES').length).toBeLessThanOrEqual(2);
    // Top 5 has unique sources
    const top5Keys = result.topItems.slice(0, 5).map((i) => i.representative_media_key);
    expect(new Set(top5Keys).size).toBe(top5Keys.length);
  });
});
