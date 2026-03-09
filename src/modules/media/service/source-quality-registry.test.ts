import { describe, it, expect } from 'vitest';
import {
  getSourceQualityPolicy,
  getAllSourceQualityPolicies,
  type SourceQualityPolicy,
  type SourceTier,
  type SourceMode,
} from './source-quality-registry.js';

// ── getSourceQualityPolicy ─────────────────────────────────────────

describe('getSourceQualityPolicy', () => {
  it('returns explicit policy for eltiempo', () => {
    const p = getSourceQualityPolicy('eltiempo');
    expect(p.mediaKey).toBe('eltiempo');
    expect(p.source_tier).toBe('HIGH');
    expect(p.source_mode).toBe('MIXED');
    expect(p.allow_in_feed).toBe(true);
    expect(p.single_source_allowed).toBe(true);
    expect(p.ranking_multiplier).toBe(1.0);
  });

  it('returns explicit policy for razon_publica', () => {
    const p = getSourceQualityPolicy('razon_publica');
    expect(p.source_tier).toBe('MEDIUM');
    expect(p.source_mode).toBe('ANALYSIS');
    expect(p.ranking_multiplier).toBe(0.85);
  });

  it('returns explicit policy for consonante', () => {
    const p = getSourceQualityPolicy('consonante');
    expect(p.source_tier).toBe('HIGH');
    expect(p.source_mode).toBe('NEWS');
    expect(p.ranking_multiplier).toBe(1.0);
  });

  it('returns explicit policy for oec (blocked)', () => {
    const p = getSourceQualityPolicy('oec');
    expect(p.source_tier).toBe('LOW');
    expect(p.source_mode).toBe('INSTITUTIONAL');
    expect(p.allow_in_feed).toBe(false);
    expect(p.single_source_allowed).toBe(false);
    expect(p.ranking_multiplier).toBe(0.4);
  });

  it('returns explicit policy for aciur (blocked)', () => {
    const p = getSourceQualityPolicy('aciur');
    expect(p.source_tier).toBe('LOW');
    expect(p.source_mode).toBe('INSTITUTIONAL');
    expect(p.allow_in_feed).toBe(false);
    expect(p.single_source_allowed).toBe(false);
    expect(p.ranking_multiplier).toBe(0.4);
  });

  it('returns explicit policy for ascolbi (blocked)', () => {
    const p = getSourceQualityPolicy('ascolbi');
    expect(p.source_tier).toBe('LOW');
    expect(p.source_mode).toBe('MIXED');
    expect(p.allow_in_feed).toBe(false);
    expect(p.ranking_multiplier).toBe(0.5);
  });

  it('returns default policy for unknown source', () => {
    const p = getSourceQualityPolicy('totally_unknown_source');
    expect(p.mediaKey).toBe('totally_unknown_source');
    expect(p.source_tier).toBe('MEDIUM');
    expect(p.source_mode).toBe('MIXED');
    expect(p.allow_in_feed).toBe(true);
    expect(p.single_source_allowed).toBe(true);
    expect(p.ranking_multiplier).toBe(1.0);
  });

  it('returns default for empty string mediaKey', () => {
    const p = getSourceQualityPolicy('');
    expect(p.source_tier).toBe('MEDIUM');
    expect(p.allow_in_feed).toBe(true);
  });

  it('default policy preserves mediaKey', () => {
    const p = getSourceQualityPolicy('new_media');
    expect(p.mediaKey).toBe('new_media');
  });

  it('explicit policy includes notes when present', () => {
    const p = getSourceQualityPolicy('eltiempo');
    expect(p.notes).toBeDefined();
    expect(typeof p.notes).toBe('string');
  });
});

// ── getAllSourceQualityPolicies ─────────────────────────────────────

describe('getAllSourceQualityPolicies', () => {
  it('returns all seeded policies', () => {
    const all = getAllSourceQualityPolicies();
    expect(all.length).toBeGreaterThanOrEqual(6);
  });

  it('includes eltiempo in seeded policies', () => {
    const all = getAllSourceQualityPolicies();
    const et = all.find((p) => p.mediaKey === 'eltiempo');
    expect(et).toBeDefined();
    expect(et!.source_tier).toBe('HIGH');
  });

  it('includes all 6 specified sources', () => {
    const all = getAllSourceQualityPolicies();
    const keys = all.map((p) => p.mediaKey);
    expect(keys).toContain('eltiempo');
    expect(keys).toContain('razon_publica');
    expect(keys).toContain('consonante');
    expect(keys).toContain('oec');
    expect(keys).toContain('aciur');
    expect(keys).toContain('ascolbi');
  });

  it('does not include unknown sources', () => {
    const all = getAllSourceQualityPolicies();
    const keys = all.map((p) => p.mediaKey);
    expect(keys).not.toContain('unknown');
    expect(keys).not.toContain('totally_new');
  });

  it('all seeded policies have valid tiers', () => {
    const validTiers: SourceTier[] = ['HIGH', 'MEDIUM', 'LOW'];
    const all = getAllSourceQualityPolicies();
    for (const p of all) {
      expect(validTiers).toContain(p.source_tier);
    }
  });

  it('all seeded policies have valid modes', () => {
    const validModes: SourceMode[] = ['NEWS', 'ANALYSIS', 'INSTITUTIONAL', 'MIXED'];
    const all = getAllSourceQualityPolicies();
    for (const p of all) {
      expect(validModes).toContain(p.source_mode);
    }
  });

  it('all ranking multipliers are in (0, 1] range', () => {
    const all = getAllSourceQualityPolicies();
    for (const p of all) {
      expect(p.ranking_multiplier).toBeGreaterThan(0);
      expect(p.ranking_multiplier).toBeLessThanOrEqual(1);
    }
  });
});
