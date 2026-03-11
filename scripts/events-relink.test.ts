import { describe, it, expect } from 'vitest';
import {
  parseRelinkArgs,
  configFromRelinkArgs,
  shouldBlockPair,
  reclusterArticles,
  detectQualityIssues,
  formatRelinkSummary,
  type RelinkArticle,
  type RelinkSummary,
} from './events-relink.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeArticle(overrides: Partial<RelinkArticle> & { id: string }): RelinkArticle {
  return {
    title: 'Gobierno presenta reforma tributaria',
    url: 'https://example.com/politica/1',
    embeddingVec: new Array(128).fill(0.1),
    publishedAt: new Date('2026-03-01T12:00:00Z'),
    contentType: 'news',
    mediaId: 'media-1',
    ...overrides,
  };
}

function makeVec(base: number, dim = 128): number[] {
  return new Array(dim).fill(base).map((v, i) => v + i * 0.001);
}

// ── CLI arg parsing ──────────────────────────────────────────────────

describe('parseRelinkArgs', () => {
  it('parses --sinceHours, --limit, and --apply', () => {
    const args = parseRelinkArgs(['node', 'script.ts', '--sinceHours=48', '--limit=100', '--apply']);
    expect(args).toEqual({ sinceHours: '48', limit: '100', apply: '1' });
  });

  it('returns empty for no args', () => {
    expect(parseRelinkArgs(['node', 'script.ts'])).toEqual({});
  });
});

describe('configFromRelinkArgs', () => {
  it('defaults: sinceHours=24, limit=200, apply=false', () => {
    const cfg = configFromRelinkArgs({});
    expect(cfg.sinceHours).toBe(24);
    expect(cfg.limit).toBe(200);
    expect(cfg.apply).toBe(false);
  });

  it('apply=true when present', () => {
    const cfg = configFromRelinkArgs({ apply: '1' });
    expect(cfg.apply).toBe(true);
  });
});

// ── shouldBlockPair ──────────────────────────────────────────────────

describe('shouldBlockPair', () => {
  it('blocks SALUD vs DEPORTES articles (desk mismatch)', () => {
    const a = makeArticle({ id: 'a1', url: 'https://a.com/salud/1', title: 'Vacuna COVID hospital' });
    const b = makeArticle({ id: 'a2', url: 'https://b.com/deportes/1', title: 'Selección gol mundial' });
    const result = shouldBlockPair(a, b);
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('DESK_MISMATCH');
  });

  it('does NOT block POLITICA vs ECONOMIA (compatible desks)', () => {
    const a = makeArticle({ id: 'a1', url: 'https://a.com/politica/1', title: 'Gobierno reforma' });
    const b = makeArticle({ id: 'a2', url: 'https://b.com/economia/1', title: 'PIB crecimiento economía' });
    const result = shouldBlockPair(a, b);
    expect(result.reasons).not.toContain('DESK_MISMATCH');
  });

  it('blocks articles with different high-confidence topics', () => {
    const a = makeArticle({ id: 'a1', title: 'Selección Colombia fútbol gol mundial eliminatoria', url: 'https://a.com/deportes/1' });
    const b = makeArticle({ id: 'a2', title: 'Gobierno reforma tributaria congreso senado presidente', url: 'https://b.com/politica/1' });
    const result = shouldBlockPair(a, b);
    expect(result.blocked).toBe(true);
    // Should have at least one of TOPIC or DESK mismatch
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('does NOT block articles with same topic and compatible desk', () => {
    const a = makeArticle({ id: 'a1', title: 'Gobierno presenta reforma tributaria fiscal al congreso', url: 'https://a.com/politica/1' });
    const b = makeArticle({
      id: 'a2', title: 'Presidente defiende reforma tributaria en el senado debate',
      url: 'https://b.com/politica/2',
      embeddingVec: makeVec(0.1),
    });
    const result = shouldBlockPair(a, b);
    expect(result.reasons).not.toContain('DESK_MISMATCH');
  });

  it('blocks title contradiction with low overlap and low embedding similarity', () => {
    // Make truly different vectors (orthogonal: one is [1,0,1,0,...] other is [0,1,0,1,...])
    const vecA = new Array(128).fill(0).map((_, i) => i % 2 === 0 ? 0.5 : 0.0);
    const vecB = new Array(128).fill(0).map((_, i) => i % 2 === 0 ? 0.0 : 0.5);
    const a = makeArticle({
      id: 'a1',
      title: 'Zxyzab aaaabb bbbbcc ccccdd',
      embeddingVec: vecA,
      url: 'https://a.com/art/1',
    });
    const b = makeArticle({
      id: 'a2',
      title: 'Qqqqab rrrrbb sssscc ttttdd',
      embeddingVec: vecB,
      url: 'https://b.com/art/2',
    });
    const result = shouldBlockPair(a, b);
    // Titles have zero keyword/entity overlap, and embeddings are orthogonal (cosine ≈ 0)
    expect(result.blocked).toBe(true);
    expect(result.reasons).toContain('TITLE_CONTRADICTION');
  });
});

// ── reclusterArticles ────────────────────────────────────────────────

describe('reclusterArticles', () => {
  it('returns single cluster for compatible articles', () => {
    const vec = makeVec(0.5);
    const articles = [
      makeArticle({ id: 'a1', embeddingVec: vec, title: 'Gobierno reforma tributaria congreso senado', url: 'https://a.com/politica/1' }),
      makeArticle({ id: 'a2', embeddingVec: vec, title: 'Presidente defiende reforma fiscal al senado', url: 'https://b.com/politica/2' }),
      makeArticle({ id: 'a3', embeddingVec: vec, title: 'Congreso aprueba reforma tributaria en pleno', url: 'https://c.com/politica/3' }),
    ];
    const clusters = reclusterArticles(articles);
    expect(clusters.length).toBe(1);
    expect(clusters[0].article_ids.length).toBe(3);
  });

  it('splits into multiple clusters when articles have incompatible desks', () => {
    const vec = makeVec(0.5);
    const articles = [
      makeArticle({ id: 'a1', embeddingVec: vec, title: 'Gobierno reforma tributaria congreso fiscal senado', url: 'https://a.com/politica/1' }),
      makeArticle({ id: 'a2', embeddingVec: vec, title: 'Selección fútbol gol mundial copa eliminatoria', url: 'https://b.com/deportes/1' }),
      makeArticle({ id: 'a3', embeddingVec: vec, title: 'Hospital vacuna paciente médico salud enfermedad', url: 'https://c.com/salud/1' }),
    ];
    const clusters = reclusterArticles(articles);
    // Should be at least 2 clusters (POLITICA, DEPORTES, SALUD all incompatible)
    expect(clusters.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty array for empty input', () => {
    expect(reclusterArticles([])).toEqual([]);
  });

  it('returns single cluster with one article', () => {
    const clusters = reclusterArticles([makeArticle({ id: 'a1' })]);
    expect(clusters.length).toBe(1);
    expect(clusters[0].article_ids).toEqual(['a1']);
  });

  it('is deterministic: same input → same output', () => {
    const vec = makeVec(0.5);
    const articles = [
      makeArticle({ id: 'a1', embeddingVec: vec, url: 'https://a.com/politica/1' }),
      makeArticle({ id: 'a2', embeddingVec: vec, url: 'https://b.com/deportes/1', title: 'Fútbol mundial gol copa selección eliminatoria' }),
    ];
    const r1 = reclusterArticles(articles);
    const r2 = reclusterArticles(articles);
    expect(r1).toEqual(r2);
  });
});

// ── detectQualityIssues ──────────────────────────────────────────────

describe('detectQualityIssues', () => {
  it('detects SPLIT_PROXY for mixed topics', () => {
    const articles = [
      { title: 'Gobierno reforma congreso senado presidente legislatura', url: 'https://a.com/politica/1', contentType: 'news' },
      { title: 'Selección fútbol gol mundial copa eliminatoria equipo', url: 'https://b.com/deportes/2', contentType: 'news' },
      { title: 'Hospital vacuna paciente médico salud enfermedad', url: 'https://c.com/salud/3', contentType: 'news' },
    ];
    const issues = detectQualityIssues(articles);
    expect(issues).toContain('SPLIT_PROXY');
  });

  it('detects COHERENCE_FAIL from coherence gate', () => {
    const articles = [{ title: 'test', url: null, contentType: 'news' }];
    const issues = detectQualityIssues(articles, { status: 'FAIL' });
    expect(issues).toContain('COHERENCE_FAIL');
  });

  it('detects LOW_TITLE_ALIGNMENT', () => {
    const articles = [{ title: 'test', url: null, contentType: 'news' }];
    const issues = detectQualityIssues(articles, { status: 'PASS', metrics: { title_jaccard: 0.05 } });
    expect(issues).toContain('LOW_TITLE_ALIGNMENT');
  });

  it('detects LOW_ENTITY_OVERLAP', () => {
    const articles = [{ title: 'test', url: null, contentType: 'news' }];
    const issues = detectQualityIssues(articles, { status: 'PASS', metrics: { entity_jaccard: 0.03 } });
    expect(issues).toContain('LOW_ENTITY_OVERLAP');
  });

  it('returns empty for healthy event', () => {
    const articles = [
      { title: 'Gobierno reforma congreso senado presidente', url: 'https://a.com/politica/1', contentType: 'news' },
      { title: 'Presidente presenta reforma al congreso senado', url: 'https://b.com/politica/2', contentType: 'news' },
      { title: 'Congreso aprueba la reforma gobierno presidente', url: 'https://c.com/politica/3', contentType: 'news' },
    ];
    const issues = detectQualityIssues(articles, { status: 'PASS', metrics: { title_jaccard: 0.5, entity_jaccard: 0.3 } });
    expect(issues).toEqual([]);
  });
});

// ── formatRelinkSummary ──────────────────────────────────────────────

describe('formatRelinkSummary', () => {
  it('produces valid NDJSON', () => {
    const summary: RelinkSummary = {
      mode: 'dry-run',
      events_scanned: 10,
      events_with_issues: 3,
      events_already_superseded: 0,
      events_single_cluster: 1,
      merges_attempted: 3,
      merges_blocked: { DESK_MISMATCH: 2, TOPIC_MISMATCH_HIGH_CONF: 1 },
      merges_applied: 0,
      results: [
        {
          original_event_id: 'evt-1',
          articles_count: 5,
          quality_issues: ['SPLIT_PROXY'],
          new_clusters: [{ article_ids: ['a1', 'a2'], new_event_id: null }, { article_ids: ['a3'], new_event_id: null }],
          action: 'RELINKED',
        },
        {
          original_event_id: 'evt-2',
          articles_count: 4,
          quality_issues: [],
          new_clusters: [],
          action: 'SKIP_OK',
        },
      ],
    };
    const text = formatRelinkSummary(summary);
    const lines = text.trim().split('\n');
    // Should have summary + 1 non-SKIP_OK result
    expect(lines.length).toBe(2);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('relink_summary');
    expect(parsed[0].merges_attempted).toBe(3);
    expect(parsed[1].kind).toBe('relink_event');
    expect(parsed[1].action).toBe('RELINKED');
  });
});

// ── Idempotency ──────────────────────────────────────────────────────

describe('recluster idempotency', () => {
  it('running recluster twice on same input produces identical clusters', () => {
    const vec = makeVec(0.3);
    const articles = [
      makeArticle({ id: 'a1', embeddingVec: vec, url: 'https://a.com/politica/1', title: 'Gobierno reforma congreso senado' }),
      makeArticle({ id: 'a2', embeddingVec: vec, url: 'https://b.com/deportes/1', title: 'Fútbol selección gol mundial copa' }),
      makeArticle({ id: 'a3', embeddingVec: vec, url: 'https://c.com/politica/2', title: 'Presidente anuncia decreto reforma congreso' }),
    ];

    const run1 = reclusterArticles(articles);
    const run2 = reclusterArticles(articles);

    expect(run1.length).toBe(run2.length);
    for (let i = 0; i < run1.length; i++) {
      expect(run1[i].article_ids).toEqual(run2[i].article_ids);
    }
  });
});
