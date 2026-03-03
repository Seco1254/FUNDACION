import { describe, it, expect } from 'vitest';
import {
  parseExportArgs,
  CSV_COLUMNS,
  compactSources,
  compactSignals,
  compactReasons,
  flattenLabel,
  deduplicateLatest,
  formatCsvHeader,
  formatCsvRow,
  formatExportOutput,
  compactArticlesSample,
  type ExportConfig,
} from './labels-export.js';

// ── parseExportArgs ──────────────────────────────────────────────

describe('parseExportArgs', () => {
  it('returns defaults with no flags', () => {
    const c = parseExportArgs(['node', 'script.ts']);
    expect(c.sinceHours).toBe(168);
    expect(c.limit).toBe(5000);
    expect(c.format).toBe('ndjson');
    expect(c.latestOnly).toBe(true);
    expect(c.includeArticles).toBe(false);
    expect(c.label).toBeNull();
    expect(c.publishedOnly).toBe(true);
  });

  it('parses all flags', () => {
    const c = parseExportArgs([
      'node', 'script.ts',
      '--sinceHours=48', '--limit=100', '--format=csv',
      '--latestOnly=0', '--includeArticles=1',
      '--label=BAD_MERGE', '--publishedOnly=0',
    ]);
    expect(c.sinceHours).toBe(48);
    expect(c.limit).toBe(100);
    expect(c.format).toBe('csv');
    expect(c.latestOnly).toBe(false);
    expect(c.includeArticles).toBe(true);
    expect(c.label).toBe('BAD_MERGE');
    expect(c.publishedOnly).toBe(false);
  });

  it('uppercases label filter', () => {
    const c = parseExportArgs(['node', 'script.ts', '--label=bad_topic']);
    expect(c.label).toBe('BAD_TOPIC');
  });
});

// ── CSV_COLUMNS contract ─────────────────────────────────────────

describe('CSV_COLUMNS', () => {
  it('has exactly 32 columns in stable order', () => {
    expect(CSV_COLUMNS).toHaveLength(32);
  });

  it('starts with event_id and ends with eligibility_reasons', () => {
    expect(CSV_COLUMNS[0]).toBe('event_id');
    expect(CSV_COLUMNS[31]).toBe('eligibility_reasons');
  });

  it('csv header matches column order exactly', () => {
    const header = formatCsvHeader(false);
    expect(header).toBe(CSV_COLUMNS.join(','));
  });

  it('csv header with articles adds articles_sample column', () => {
    const header = formatCsvHeader(true);
    expect(header).toBe([...CSV_COLUMNS, 'articles_sample'].join(','));
  });
});

// ── compact helpers ──────────────────────────────────────────────

describe('compactSources', () => {
  it('formats sources as mediaKey:count pipe-separated', () => {
    const result = compactSources([
      { mediaKey: 'eltiempo', count: 3 },
      { mediaKey: 'razon_publica', count: 1 },
    ]);
    expect(result).toBe('eltiempo:3|razon_publica:1');
  });

  it('returns empty string for null/empty', () => {
    expect(compactSources(null)).toBe('');
    expect(compactSources([])).toBe('');
    expect(compactSources(undefined)).toBe('');
  });
});

describe('compactSignals', () => {
  it('caps at 5 and joins with pipe', () => {
    const signals = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    expect(compactSignals(signals)).toBe('A|B|C|D|E');
  });

  it('returns empty for null', () => {
    expect(compactSignals(null)).toBe('');
  });
});

describe('compactReasons', () => {
  it('joins with pipe', () => {
    expect(compactReasons(['SINGLE_SOURCE', 'LOW_CONF'])).toBe('SINGLE_SOURCE|LOW_CONF');
  });
});

// ── flattenLabel ─────────────────────────────────────────────────

function makeLabelRow(overrides: Record<string, any> = {}) {
  return {
    eventId: overrides.eventId ?? 'evt-aaa',
    label: overrides.label ?? 'GOOD',
    note: overrides.note ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-03-01T12:00:00Z'),
    snapshotJson: overrides.snapshotJson ?? {},
  };
}

describe('flattenLabel', () => {
  it('produces all 32 keys from empty snapshot', () => {
    const row = flattenLabel(makeLabelRow(), false);
    const keys = Object.keys(row);
    // All CSV_COLUMNS must be present
    for (const col of CSV_COLUMNS) {
      expect(keys).toContain(col);
    }
  });

  it('extracts coverage fields from snapshot', () => {
    const row = flattenLabel(makeLabelRow({
      snapshotJson: {
        title: 'Test Event',
        publishAt: '2026-03-01T10:00:00.000Z',
        coverage: {
          num_articles: 5,
          num_sources_unique: 3,
          sources: [{ mediaKey: 'eltiempo', count: 3 }, { mediaKey: 'semana', count: 2 }],
        },
      },
    }), false);
    expect(row.title).toBe('Test Event');
    expect(row.num_articles).toBe(5);
    expect(row.num_sources_unique).toBe(3);
    expect(row.sources).toBe('eltiempo:3|semana:2');
  });

  it('extracts topic fields', () => {
    const row = flattenLabel(makeLabelRow({
      snapshotJson: {
        topic_key: 'POLITICA',
        topic_confidence: 0.85,
        topic_reason: 'DESK_BOOST+CO_KW',
        topic_signals: ['DESK_BOOST:POLITICA', 'CO_KW:gobierno'],
      },
    }), false);
    expect(row.topic_key).toBe('POLITICA');
    expect(row.topic_confidence).toBe(0.85);
    expect(row.topic_signals).toBe('DESK_BOOST:POLITICA|CO_KW:gobierno');
  });

  it('extracts coherence gate metrics', () => {
    const row = flattenLabel(makeLabelRow({
      snapshotJson: {
        coherence_gate: {
          status: 'PASS',
          metrics: { avg_cosine: 0.82, entity_jaccard: 0.45, title_jaccard: 0.3, stddev_drift: 0.05 },
        },
      },
    }), false);
    expect(row.coherence_status).toBe('PASS');
    expect(row.cohesion).toBe(0.82);
    expect(row.entity_overlap).toBe(0.45);
    expect(row.title_alignment).toBe(0.3);
    expect(row.topic_drift).toBe(0.05);
  });

  it('extracts representative article fields', () => {
    const row = flattenLabel(makeLabelRow({
      snapshotJson: {
        representative_article: {
          url: 'https://eltiempo.com/art-1',
          mediaKey: 'eltiempo',
          text_len: 2500,
          page_type: 'news',
          desk: 'POLITICA',
          desk_source: 'url_segment',
          blocked_reason: null,
        },
      },
    }), false);
    expect(row.rep_url).toBe('https://eltiempo.com/art-1');
    expect(row.rep_mediaKey).toBe('eltiempo');
    expect(row.rep_text_len).toBe(2500);
    expect(row.rep_desk).toBe('POLITICA');
    expect(row.rep_desk_source).toBe('url_segment');
  });

  it('null-safe on completely empty snapshot', () => {
    const row = flattenLabel(makeLabelRow({ snapshotJson: {} }), false);
    expect(row.title).toBeNull();
    expect(row.num_articles).toBeNull();
    expect(row.topic_key).toBeNull();
    expect(row.coherence_status).toBeNull();
    expect(row.rep_url).toBeNull();
    expect(row.eligibility_feed_eligible).toBeNull();
  });

  it('includes articles_sample when includeArticles=true', () => {
    const row = flattenLabel(makeLabelRow({
      snapshotJson: {
        representative_article: { url: 'https://a.com/1', mediaKey: 'a', text_len: 100 },
        coverage: { sources: [{ mediaKey: 'a', count: 2 }, { mediaKey: 'b', count: 1 }] },
      },
    }), true);
    expect(row.articles_sample).toBeDefined();
    const parsed = JSON.parse(row.articles_sample!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeLessThanOrEqual(5);
    expect(parsed[0].url).toBe('https://a.com/1'); // rep first
  });
});

// ── deduplicateLatest ────────────────────────────────────────────

describe('deduplicateLatest', () => {
  it('keeps only the most recent label per event_id', () => {
    const rows = [
      { eventId: 'e1', label: 'GOOD', createdAt: new Date('2026-03-01T12:00:00Z') },
      { eventId: 'e1', label: 'BAD_MERGE', createdAt: new Date('2026-03-02T12:00:00Z') },
      { eventId: 'e2', label: 'GOOD', createdAt: new Date('2026-03-01T12:00:00Z') },
    ];
    const result = deduplicateLatest(rows);
    expect(result).toHaveLength(2);
    const e1 = result.find((r) => r.eventId === 'e1');
    expect(e1!.label).toBe('BAD_MERGE'); // more recent
  });

  it('handles single row', () => {
    const rows = [{ eventId: 'e1', label: 'GOOD', createdAt: new Date() }];
    expect(deduplicateLatest(rows)).toHaveLength(1);
  });

  it('handles empty input', () => {
    expect(deduplicateLatest([])).toHaveLength(0);
  });
});

// ── compactArticlesSample ────────────────────────────────────────

describe('compactArticlesSample', () => {
  it('caps at 5 entries with representative first', () => {
    const snapshot = {
      representative_article: { url: 'https://rep.com/1', mediaKey: 'rep' },
      coverage: {
        sources: [
          { mediaKey: 'rep', count: 2 },
          { mediaKey: 'a', count: 1 },
          { mediaKey: 'b', count: 1 },
          { mediaKey: 'c', count: 1 },
          { mediaKey: 'd', count: 1 },
          { mediaKey: 'e', count: 1 },
        ],
      },
    };
    const result = compactArticlesSample(snapshot);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveLength(5);
    expect(parsed[0].url).toBe('https://rep.com/1');
    // rep's source 'rep' should be skipped, remaining 5 sources fill remaining 4 slots
    expect(parsed[1].mediaKey).toBe('a');
  });

  it('returns empty array string for null snapshot', () => {
    const result = compactArticlesSample(null);
    expect(JSON.parse(result)).toEqual([]);
  });
});

// ── label filter ─────────────────────────────────────────────────

describe('label filter in config', () => {
  it('null when not specified', () => {
    const c = parseExportArgs(['node', 'script.ts']);
    expect(c.label).toBeNull();
  });

  it('uppercased when specified', () => {
    const c = parseExportArgs(['node', 'script.ts', '--label=bad_source']);
    expect(c.label).toBe('BAD_SOURCE');
  });
});

// ── formatExportOutput ───────────────────────────────────────────

describe('formatExportOutput', () => {
  const baseConfig: ExportConfig = {
    sinceHours: 168, limit: 5000, format: 'ndjson',
    latestOnly: true, includeArticles: false, label: null, publishedOnly: true,
  };

  it('ndjson: one JSON line per row', () => {
    const rows = [
      flattenLabel(makeLabelRow({ snapshotJson: { title: 'A' } }), false),
      flattenLabel(makeLabelRow({ eventId: 'evt-bbb', snapshotJson: { title: 'B' } }), false),
    ];
    const out = formatExportOutput(rows, baseConfig);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).title).toBe('A');
    expect(JSON.parse(lines[1]).title).toBe('B');
  });

  it('csv: header + data rows', () => {
    const rows = [
      flattenLabel(makeLabelRow({ snapshotJson: { title: 'Event A' } }), false),
    ];
    const out = formatExportOutput(rows, { ...baseConfig, format: 'csv' });
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2); // header + 1 row
    expect(lines[0]).toBe(CSV_COLUMNS.join(','));
    expect(lines[1]).toContain('evt-aaa'); // event_id
    expect(lines[1]).toContain('Event A'); // title
  });

  it('csv escapes commas in values', () => {
    const rows = [
      flattenLabel(makeLabelRow({
        note: 'has, comma',
        snapshotJson: {},
      }), false),
    ];
    const out = formatExportOutput(rows, { ...baseConfig, format: 'csv' });
    expect(out).toContain('"has, comma"');
  });

  it('csv escapes double quotes in values', () => {
    const rows = [
      flattenLabel(makeLabelRow({ note: 'has "quotes"', snapshotJson: {} }), false),
    ];
    const out = formatExportOutput(rows, { ...baseConfig, format: 'csv' });
    expect(out).toContain('"has ""quotes"""');
  });

  it('ndjson empty produces no lines', () => {
    const out = formatExportOutput([], baseConfig);
    expect(out).toBe('');
  });
});

// ── publishedOnly ────────────────────────────────────────────────

describe('publishedOnly flag', () => {
  it('default is true', () => {
    const c = parseExportArgs(['node', 'script.ts']);
    expect(c.publishedOnly).toBe(true);
  });

  it('can be disabled', () => {
    const c = parseExportArgs(['node', 'script.ts', '--publishedOnly=0']);
    expect(c.publishedOnly).toBe(false);
  });
});
