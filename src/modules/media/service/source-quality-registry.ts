/**
 * Source Quality Registry — editorial metadata and feed policy per media source.
 *
 * Provides per-source tier, mode, feed eligibility, single-source eligibility,
 * and ranking multiplier. Unknown sources get a safe default (MEDIUM/MIXED/1.0).
 *
 * No DB dependency — policies are declared in code and overridable via env.
 */

// ── Types ────────────────────────────────────────────────────────────

export type SourceTier = 'HIGH' | 'MEDIUM' | 'LOW';
export type SourceMode = 'NEWS' | 'ANALYSIS' | 'INSTITUTIONAL' | 'MIXED';

export interface SourceQualityPolicy {
  mediaKey: string;
  source_tier: SourceTier;
  source_mode: SourceMode;
  allow_in_feed: boolean;
  single_source_allowed: boolean;
  ranking_multiplier: number;
  notes?: string;
}

// ── Default policy for unknown sources ───────────────────────────────

const DEFAULT_POLICY: Omit<SourceQualityPolicy, 'mediaKey'> = {
  source_tier: 'MEDIUM',
  source_mode: 'MIXED',
  allow_in_feed: true,
  single_source_allowed: true,
  ranking_multiplier: 1.0,
};

// ── Seeded policies ──────────────────────────────────────────────────

const SEEDED_POLICIES: SourceQualityPolicy[] = [
  {
    mediaKey: 'eltiempo',
    source_tier: 'HIGH',
    source_mode: 'MIXED',
    allow_in_feed: true,
    single_source_allowed: true,
    ranking_multiplier: 1.0,
    notes: 'Major national newspaper',
  },
  {
    mediaKey: 'razon_publica',
    source_tier: 'MEDIUM',
    source_mode: 'ANALYSIS',
    allow_in_feed: true,
    single_source_allowed: true,
    ranking_multiplier: 0.85,
    notes: 'Analysis/opinion outlet',
  },
  {
    mediaKey: 'consonante',
    source_tier: 'HIGH',
    source_mode: 'NEWS',
    allow_in_feed: true,
    single_source_allowed: true,
    ranking_multiplier: 1.0,
    notes: 'Regional news outlet',
  },
  {
    mediaKey: 'oec',
    source_tier: 'LOW',
    source_mode: 'INSTITUTIONAL',
    allow_in_feed: false,
    single_source_allowed: false,
    ranking_multiplier: 0.4,
    notes: 'Institutional/data source',
  },
  {
    mediaKey: 'aciur',
    source_tier: 'LOW',
    source_mode: 'INSTITUTIONAL',
    allow_in_feed: false,
    single_source_allowed: false,
    ranking_multiplier: 0.4,
    notes: 'Institutional source',
  },
  {
    mediaKey: 'ascolbi',
    source_tier: 'LOW',
    source_mode: 'MIXED',
    allow_in_feed: false,
    single_source_allowed: false,
    ranking_multiplier: 0.5,
    notes: 'Low-quality mixed source',
  },
];

// ── Registry (Map for O(1) lookup) ──────────────────────────────────

const registry = new Map<string, SourceQualityPolicy>();
for (const p of SEEDED_POLICIES) {
  registry.set(p.mediaKey, p);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Get the quality policy for a given mediaKey.
 * Returns explicit policy if registered, otherwise the default (MEDIUM/MIXED/1.0).
 */
export function getSourceQualityPolicy(mediaKey: string): SourceQualityPolicy {
  const explicit = registry.get(mediaKey);
  if (explicit) return explicit;
  return { mediaKey, ...DEFAULT_POLICY };
}

/**
 * Get all explicitly registered policies.
 */
export function getAllSourceQualityPolicies(): SourceQualityPolicy[] {
  return Array.from(registry.values());
}
