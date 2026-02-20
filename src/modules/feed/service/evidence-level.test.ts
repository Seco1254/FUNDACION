import { describe, it, expect } from 'vitest';
import { computeEvidenceLevel, buildWhyNoOverview } from './evidence-level.js';

describe('computeEvidenceLevel', () => {
  it('returns high when >= 3 sources AND >= 2000 text', () => {
    expect(computeEvidenceLevel(3, 2000)).toBe('high');
    expect(computeEvidenceLevel(5, 5000)).toBe('high');
  });

  it('returns medium when >= 2 sources AND >= 1200 text', () => {
    expect(computeEvidenceLevel(2, 1200)).toBe('medium');
    expect(computeEvidenceLevel(2, 1999)).toBe('medium');
  });

  it('returns low when >= 1 source AND >= 800 text', () => {
    expect(computeEvidenceLevel(1, 800)).toBe('low');
    expect(computeEvidenceLevel(1, 1199)).toBe('low');
  });

  it('returns none when no conditions met', () => {
    expect(computeEvidenceLevel(0, 0)).toBe('none');
    expect(computeEvidenceLevel(1, 799)).toBe('none');
    expect(computeEvidenceLevel(0, 5000)).toBe('none');
  });

  it('high requires BOTH conditions (3 sources, 2000 text)', () => {
    // 3 sources but not enough text → medium (2 sources threshold still met)
    expect(computeEvidenceLevel(3, 1200)).toBe('medium');
    // Enough text but only 2 sources → medium
    expect(computeEvidenceLevel(2, 3000)).toBe('medium');
  });

  it('medium requires BOTH conditions (2 sources, 1200 text)', () => {
    // 2 sources but only 800 text → low
    expect(computeEvidenceLevel(2, 800)).toBe('low');
  });
});

describe('buildWhyNoOverview', () => {
  it('returns null when overview is ready', () => {
    const result = buildWhyNoOverview({
      overviewStatus: 'ready',
      uniqueSourcesCount: 2,
      usableArticlesCount: 2,
      totalUsableTextLen: 2000,
      articleFailReasons: [],
    });
    expect(result).toBeNull();
  });

  it('returns diagnostic string when unavailable', () => {
    const result = buildWhyNoOverview({
      overviewStatus: 'unavailable',
      uniqueSourcesCount: 1,
      usableArticlesCount: 0,
      totalUsableTextLen: 0,
      articleFailReasons: ['paywall', 'too_short'],
    });
    expect(result).toContain('unique_sources=1');
    expect(result).toContain('usable_articles=0');
    expect(result).toContain('total_text=0');
    expect(result).toContain('fail_reasons=paywall,too_short');
  });

  it('includes status=pending prefix when pending', () => {
    const result = buildWhyNoOverview({
      overviewStatus: 'pending',
      uniqueSourcesCount: 0,
      usableArticlesCount: 0,
      totalUsableTextLen: 0,
      articleFailReasons: [],
    });
    expect(result).toMatch(/^status=pending/);
  });

  it('deduplicates fail reasons', () => {
    const result = buildWhyNoOverview({
      overviewStatus: 'unavailable',
      uniqueSourcesCount: 2,
      usableArticlesCount: 1,
      totalUsableTextLen: 500,
      articleFailReasons: ['too_short', 'too_short', 'empty'],
    });
    expect(result).toContain('fail_reasons=too_short,empty');
    // Should NOT have duplicated too_short
    expect(result!.match(/too_short/g)?.length).toBe(1);
  });

  it('omits fail_reasons when none exist', () => {
    const result = buildWhyNoOverview({
      overviewStatus: 'unavailable',
      uniqueSourcesCount: 2,
      usableArticlesCount: 2,
      totalUsableTextLen: 1500,
      articleFailReasons: [],
    });
    expect(result).not.toContain('fail_reasons');
  });
});
