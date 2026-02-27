import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  percentile,
  bucketKey,
  dbMeta,
  configFromArgs,
  buildDoctorOutput,
  formatOutput,
  type DoctorConfig,
  type LinkerLog,
  type DebugContext,
} from './feed-doctor.js';

// ── Helpers ──────────────────────────────────────────────────────

function makeArticle(overrides: Record<string, any> = {}) {
  return {
    id: overrides.id ?? 'art-1',
    url: overrides.url ?? 'https://example.com/art-1',
    title: overrides.title ?? 'Test article',
    snippet: overrides.snippet ?? 'Snippet',
    textContentLen: overrides.textContentLen ?? 1500,
    textContentSource: overrides.textContentSource ?? 'body',
    usableForOverview: overrides.usableForOverview ?? true,
    contentType: overrides.contentType ?? 'news',
    routingDecision: overrides.routingDecision ?? 'NEWS',
    status: overrides.status ?? 'POLICY_OK',
    textNorm: overrides.textNorm ?? null,
    media: overrides.media ?? { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo' },
  };
}

function makeEvent(overrides: Record<string, any> = {}) {
  const now = new Date();
  return {
    id: overrides.id ?? 'evt-1',
    state: overrides.state ?? 'PUBLISHED',
    t0: overrides.t0 ?? now,
    tLast: overrides.tLast ?? now,
    publishAt: overrides.publishAt ?? now,
    publishedAt: overrides.publishedAt ?? now,
    closedAt: null,
    canonicalEventId: null,
    createdAt: overrides.createdAt ?? now,
    versions: overrides.versions ?? [{
      id: 'ver-1',
      headline: 'Test headline',
      versionIndex: 1,
      packetJson: overrides.packetJson ?? {},
    }],
    eventArticles: overrides.eventArticles ?? [{
      createdAt: now,
      article: makeArticle(),
    }],
    ...overrides,
  };
}

const defaultConfig: DoctorConfig = {
  limit: 200,
  hours: 0,
  format: 'ndjson',
  includeArticles: true,
  includeTextSamples: false,
  minArticles: 1,
  minSources: 1,
  publishedOnly: false,
  stateFilter: null,
};

// ── Unit tests for helpers ───────────────────────────────────────

describe('parseArgs', () => {
  it('parses --key=value flags', () => {
    const result = parseArgs(['node', 'script.ts', '--limit=50', '--hours=12', '--format=json']);
    expect(result).toEqual({ limit: '50', hours: '12', format: 'json' });
  });

  it('returns empty for no flags', () => {
    expect(parseArgs(['node', 'script.ts'])).toEqual({});
  });

  it('ignores positional args', () => {
    expect(parseArgs(['node', 'script.ts', 'positional', '--flag=val'])).toEqual({ flag: 'val' });
  });
});

describe('percentile', () => {
  it('returns 0 for empty array', () => {
    expect(percentile([], 50)).toBe(0);
  });

  it('computes p50 of sorted values', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it('computes p90 of sorted values', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
  });
});

describe('bucketKey', () => {
  it('returns exact number for 0-2', () => {
    expect(bucketKey(0)).toBe('0');
    expect(bucketKey(1)).toBe('1');
    expect(bucketKey(2)).toBe('2');
  });

  it('returns 3-4 for 3 and 4', () => {
    expect(bucketKey(3)).toBe('3-4');
    expect(bucketKey(4)).toBe('3-4');
  });

  it('returns 5-9 for 5 through 9', () => {
    expect(bucketKey(5)).toBe('5-9');
    expect(bucketKey(9)).toBe('5-9');
  });

  it('returns 10+ for 10 and above', () => {
    expect(bucketKey(10)).toBe('10+');
    expect(bucketKey(100)).toBe('10+');
  });
});

describe('dbMeta', () => {
  it('parses a postgres URL', () => {
    expect(dbMeta('postgresql://user:pass@localhost:5432/fundacion')).toEqual({
      host: 'localhost:5432',
      name: 'fundacion',
    });
  });

  it('returns unknown for invalid URL', () => {
    expect(dbMeta('invalid')).toEqual({ host: 'unknown', name: 'unknown' });
  });
});

describe('configFromArgs', () => {
  it('applies defaults (hours=0 means all-time)', () => {
    const cfg = configFromArgs({});
    expect(cfg.limit).toBe(200);
    expect(cfg.hours).toBe(0);
    expect(cfg.format).toBe('ndjson');
    expect(cfg.includeArticles).toBe(true);
    expect(cfg.includeTextSamples).toBe(false);
    expect(cfg.minArticles).toBe(1);
    expect(cfg.minSources).toBe(1);
    expect(cfg.publishedOnly).toBe(false);
    expect(cfg.stateFilter).toBeNull();
  });

  it('overrides from args', () => {
    const cfg = configFromArgs({ limit: '10', hours: '6', format: 'json', include_articles: '0', include_text_samples: '1' });
    expect(cfg.limit).toBe(10);
    expect(cfg.hours).toBe(6);
    expect(cfg.format).toBe('json');
    expect(cfg.includeArticles).toBe(false);
    expect(cfg.includeTextSamples).toBe(true);
  });

  it('parses --published_only=1', () => {
    const cfg = configFromArgs({ published_only: '1' });
    expect(cfg.publishedOnly).toBe(true);
  });

  it('parses --state=DETECTED (case-insensitive)', () => {
    const cfg = configFromArgs({ state: 'detected' });
    expect(cfg.stateFilter).toBe('DETECTED');
  });

  it('ignores invalid --state values', () => {
    const cfg = configFromArgs({ state: 'INVALID' });
    expect(cfg.stateFilter).toBeNull();
  });
});

// ── Core output tests ────────────────────────────────────────────

describe('buildDoctorOutput', () => {
  it('always includes run_meta as first and aggregate as last', () => {
    const output = buildDoctorOutput([], [], defaultConfig);
    expect(output.length).toBe(2);
    expect(output[0].kind).toBe('run_meta');
    expect(output[1].kind).toBe('aggregate');
  });

  it('run_meta contains expected fields', () => {
    const now = new Date('2026-02-26T12:00:00Z');
    const output = buildDoctorOutput([], [], defaultConfig, now);
    const meta = output[0];
    expect(meta.kind).toBe('run_meta');
    expect(meta.time_iso).toBe('2026-02-26T12:00:00.000Z');
    expect(meta.node_version).toBe(process.version);
    expect(meta.params.limit).toBe(200);
    expect(meta.params.hours).toBe(0);
    expect(meta.env).toHaveProperty('PUBLISH_DELAY_MS');
    expect(meta.env).toHaveProperty('GATE_MULTI_SOURCES');
  });

  it('aggregate totals reflect event count', () => {
    const ev1 = makeEvent({ id: 'evt-1' });
    const ev2 = makeEvent({
      id: 'evt-2',
      eventArticles: [{ createdAt: new Date(), article: makeArticle({ id: 'art-2', media: { id: 'media-2', mediaKey: 'semana', name: 'Semana' } }) }],
    });
    const output = buildDoctorOutput([ev1, ev2], [], defaultConfig);
    const agg = output[output.length - 1];
    expect(agg.kind).toBe('aggregate');
    expect(agg.totals.events_fetched).toBe(2);
    expect(agg.totals.events_emitted).toBe(2);
    expect(agg.totals.events_published).toBe(2);
  });

  it('produces event records with required sections', () => {
    const ev = makeEvent();
    const output = buildDoctorOutput([ev], [], defaultConfig);
    expect(output.length).toBe(3); // run_meta + 1 event + aggregate
    const record = output[1];
    expect(record.kind).toBe('event');
    expect(record.event_id).toBe('evt-1');
    expect(record).toHaveProperty('coverage');
    expect(record).toHaveProperty('topics');
    expect(record).toHaveProperty('routing');
    expect(record).toHaveProperty('eligibility');
    expect(record).toHaveProperty('coherence_gate');
    expect(record).toHaveProperty('quality_flags');
    expect(record).toHaveProperty('linker_summary');
    expect(record).toHaveProperty('ranking_features');
  });

  it('include_articles limits to 10 articles', () => {
    const articles = Array.from({ length: 15 }, (_, i) =>
      ({ createdAt: new Date(), article: makeArticle({ id: `art-${i}`, url: `https://example.com/art-${i}` }) }),
    );
    const ev = makeEvent({ eventArticles: articles });
    const output = buildDoctorOutput([ev], [], { ...defaultConfig, includeArticles: true });
    const record = output[1];
    expect(record.articles).toBeDefined();
    expect(record.articles.length).toBe(10);
  });

  it('excludes articles when includeArticles=false', () => {
    const ev = makeEvent();
    const output = buildDoctorOutput([ev], [], { ...defaultConfig, includeArticles: false });
    expect(output[1].articles).toBeUndefined();
  });

  it('respects minArticles filter', () => {
    const ev = makeEvent(); // 1 article
    const output = buildDoctorOutput([ev], [], { ...defaultConfig, minArticles: 5 });
    // Event should be filtered out from records but counted in fetched
    expect(output.length).toBe(2); // run_meta + aggregate only
    expect(output[1].totals.events_fetched).toBe(1); // raw count stays
    expect(output[1].totals.events_emitted).toBe(0);
  });

  it('respects minSources filter', () => {
    const ev = makeEvent(); // 1 source
    const output = buildDoctorOutput([ev], [], { ...defaultConfig, minSources: 3 });
    expect(output.length).toBe(2); // run_meta + aggregate only
  });

  it('includes text_samples when config enables it', () => {
    const ev = makeEvent({
      versions: [{ id: 'ver-1', headline: 'Big headline text here', versionIndex: 1, packetJson: {} }],
      eventArticles: [{ createdAt: new Date(), article: makeArticle({ textNorm: 'Body text content here' }) }],
    });
    const output = buildDoctorOutput([ev], [], { ...defaultConfig, includeTextSamples: true });
    const record = output[1];
    expect(record.text_samples).toBeDefined();
    expect(record.text_samples.headline_snippet).toBe('Big headline text here');
    expect(record.text_samples.body_snippet).toBe('Body text content here');
  });

  it('populates linker_summary from audit logs', () => {
    const ev = makeEvent({ id: 'evt-1' });
    const logs: LinkerLog[] = [
      { entityId: 'evt-1', action: 'AUTO_LINK', data: { reasons: ['high_score'] } },
      { entityId: 'evt-1', action: 'AUTO_LINK', data: {} },
      { entityId: 'evt-1', action: 'HARD_NEGATIVE_BLOCK', data: { reason: 'temporal_gap' } },
    ];
    const output = buildDoctorOutput([ev], logs, defaultConfig);
    const record = output[1];
    expect(record.linker_summary.auto_links).toBe(2);
    expect(record.linker_summary.hard_negative_blocks).toBe(1);
    expect(record.linker_summary.top_reasons).toContain('high_score');
  });

  it('computes ranking_features with numeric scores', () => {
    const ev = makeEvent();
    const output = buildDoctorOutput([ev], [], defaultConfig);
    const rf = output[1].ranking_features;
    expect(typeof rf.recency_score).toBe('number');
    expect(typeof rf.coverage_score).toBe('number');
    expect(typeof rf.final_rank_score).toBe('number');
  });
});

// ── Format tests ─────────────────────────────────────────────────

describe('formatOutput', () => {
  it('NDJSON: 1 JSON per line, each parseable', () => {
    const records = [
      { kind: 'run_meta', time_iso: '2026-02-26T12:00:00Z' },
      { kind: 'event', event_id: 'evt-1' },
      { kind: 'aggregate', totals: { events: 1 } },
    ];
    const text = formatOutput(records, 'ndjson');
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(3);
    for (const line of lines) {
      const parsed = JSON.parse(line);
      expect(parsed).toHaveProperty('kind');
    }
  });

  it('JSON: single parseable array', () => {
    const records = [{ kind: 'run_meta' }, { kind: 'aggregate' }];
    const text = formatOutput(records, 'json');
    const parsed = JSON.parse(text);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);
  });
});

// ── Integration: full pipeline with mock data ────────────────────

describe('buildDoctorOutput full pipeline', () => {
  it('produces valid NDJSON with run_meta + events + aggregate', () => {
    const now = new Date();
    const events = [
      makeEvent({
        id: 'evt-A',
        eventArticles: [
          { createdAt: now, article: makeArticle({ id: 'a1', media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' } }) },
          { createdAt: now, article: makeArticle({ id: 'a2', media: { id: 'm2', mediaKey: 'semana', name: 'Semana' } }) },
        ],
        versions: [{
          id: 'v1', headline: 'Headline A', versionIndex: 1,
          packetJson: { topic_keys: ['politica'], topic_scores: { politica: 0.9 } },
        }],
      }),
      makeEvent({
        id: 'evt-B',
        eventArticles: [
          { createdAt: now, article: makeArticle({ id: 'a3', media: { id: 'm3', mediaKey: 'rcn', name: 'RCN' } }) },
        ],
      }),
    ];

    const output = buildDoctorOutput(events, [], defaultConfig, now);
    const text = formatOutput(output, 'ndjson');

    // Validate NDJSON
    const lines = text.trim().split('\n');
    expect(lines.length).toBe(4); // run_meta + 2 events + aggregate

    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].kind).toBe('run_meta');
    expect(parsed[1].kind).toBe('event');
    expect(parsed[2].kind).toBe('event');
    expect(parsed[3].kind).toBe('aggregate');

    // Verify coverage of first event
    expect(parsed[1].coverage.num_articles).toBe(2);
    expect(parsed[1].coverage.num_sources_unique).toBe(2);

    // Verify aggregate
    expect(parsed[3].totals.events_fetched).toBe(2);
    expect(parsed[3].totals.events_emitted).toBe(2);
  });
});

// ── New tests: --hours=0, --published_only, --state, debug block ──

describe('buildDoctorOutput with mixed states', () => {
  it('events_published counts only PUBLISHED events', () => {
    const events = [
      makeEvent({ id: 'evt-pub', state: 'PUBLISHED' }),
      makeEvent({ id: 'evt-det', state: 'DETECTED' }),
      makeEvent({ id: 'evt-pen', state: 'PENDING_PUBLISH' }),
    ];
    const output = buildDoctorOutput(events, [], defaultConfig);
    const agg = output[output.length - 1];
    expect(agg.totals.events_fetched).toBe(3);
    expect(agg.totals.events_published).toBe(1);
    expect(agg.totals.events_emitted).toBe(3);
  });
});

describe('debug context in aggregate', () => {
  it('includes debug block when debugCtx is provided', () => {
    const ctx: DebugContext = {
      total_events_in_db: 13,
      total_published_in_db: 11,
      applied_time_filter: 'none (all-time)',
      applied_state_filter: 'PUBLISHED',
    };
    const output = buildDoctorOutput([], [], defaultConfig, new Date(), ctx);
    const agg = output[output.length - 1];
    expect(agg.debug).toBeDefined();
    expect(agg.debug.total_events_in_db).toBe(13);
    expect(agg.debug.total_published_in_db).toBe(11);
    expect(agg.debug.applied_time_filter).toBe('none (all-time)');
    expect(agg.debug.applied_state_filter).toBe('PUBLISHED');
    expect(agg.debug.min_articles).toBe(1);
    expect(agg.debug.min_sources).toBe(1);
  });

  it('omits debug block when debugCtx is not provided', () => {
    const output = buildDoctorOutput([], [], defaultConfig);
    const agg = output[output.length - 1];
    expect(agg.debug).toBeUndefined();
  });
});

describe('run_meta includes new params', () => {
  it('run_meta.params includes published_only and state_filter', () => {
    const cfg: DoctorConfig = { ...defaultConfig, publishedOnly: true, stateFilter: 'DETECTED' };
    const output = buildDoctorOutput([], [], cfg);
    const meta = output[0];
    expect(meta.params.published_only).toBe(true);
    expect(meta.params.state_filter).toBe('DETECTED');
  });

  it('run_meta.params.hours=0 for all-time', () => {
    const output = buildDoctorOutput([], [], defaultConfig);
    expect(output[0].params.hours).toBe(0);
  });
});
