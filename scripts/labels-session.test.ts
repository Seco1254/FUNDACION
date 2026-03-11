import { describe, it, expect } from 'vitest';
import {
  parseSessionArgs,
  buildSessionRow,
  formatSessionTable,
  formatSessionNdjson,
  formatSessionOutput,
  type SessionRow,
} from './labels-session.js';

// ── parseSessionArgs ─────────────────────────────────────────────

describe('parseSessionArgs', () => {
  it('returns defaults with no flags', () => {
    const c = parseSessionArgs(['node', 'script.ts']);
    expect(c.hours).toBe(6);
    expect(c.limit).toBe(20);
    expect(c.publishedOnly).toBe(true);
    expect(c.format).toBe('table');
  });

  it('parses all flags', () => {
    const c = parseSessionArgs([
      'node', 'script.ts',
      '--hours=24', '--limit=10', '--publishedOnly=0', '--format=ndjson',
    ]);
    expect(c.hours).toBe(24);
    expect(c.limit).toBe(10);
    expect(c.publishedOnly).toBe(false);
    expect(c.format).toBe('ndjson');
  });

  it('defaults format to table for unknown values', () => {
    const c = parseSessionArgs(['node', 'script.ts', '--format=csv']);
    expect(c.format).toBe('table');
  });
});

// ── buildSessionRow ──────────────────────────────────────────────

function makeEvent(overrides: Record<string, any> = {}) {
  const now = new Date('2026-03-01T12:00:00Z');
  return {
    id: overrides.id ?? '12345678-aaaa-bbbb-cccc-dddddddddddd',
    state: overrides.state ?? 'PUBLISHED',
    publishAt: overrides.publishAt ?? now,
    versions: overrides.versions ?? [{
      headline: overrides.headline ?? 'Gobierno anuncia reforma tributaria',
      packetJson: overrides.packetJson ?? {},
      versionIndex: 1,
    }],
    eventArticles: overrides.eventArticles ?? [
      {
        article: {
          id: 'a1', url: 'https://eltiempo.com/politica/reforma-123',
          title: 'Reforma tributaria anunciada',
          textContentLen: 2500, contentType: 'news',
          media: { mediaKey: 'eltiempo' },
        },
      },
      {
        article: {
          id: 'a2', url: 'https://semana.com/nacion/reforma-456',
          title: 'Nueva reforma fiscal en Colombia',
          textContentLen: 1800, contentType: 'news',
          media: { mediaKey: 'semana' },
        },
      },
    ],
  };
}

describe('buildSessionRow', () => {
  it('produces all required fields', () => {
    const row = buildSessionRow(makeEvent());
    expect(row.event_id).toBe('12345678-aaaa-bbbb-cccc-dddddddddddd');
    expect(row.event_id_short).toBe('12345678');
    expect(row.title).toBe('Gobierno anuncia reforma tributaria');
    expect(row.topic_key).toBeDefined();
    expect(row.topic_confidence).toBeDefined();
    expect(row.num_articles).toBe(2);
    expect(row.num_sources_unique).toBe(2);
    expect(row.rep_url).toBeDefined();
    expect(row.publishAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('handles event with no articles', () => {
    const row = buildSessionRow(makeEvent({ eventArticles: [] }));
    expect(row.num_articles).toBe(0);
    expect(row.num_sources_unique).toBe(0);
    expect(row.rep_url).toBeNull();
  });

  it('handles event with no version', () => {
    const row = buildSessionRow(makeEvent({ versions: [] }));
    expect(row.title).toBeNull();
  });
});

// ── formatSessionTable ───────────────────────────────────────────

describe('formatSessionTable', () => {
  it('returns placeholder for empty input', () => {
    expect(formatSessionTable([])).toContain('no events found');
  });

  it('renders header columns and rows', () => {
    const rows: SessionRow[] = [{
      event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd',
      event_id_short: '12345678',
      title: 'Test headline',
      topic_key: 'POLITICA',
      topic_confidence: 0.85,
      num_articles: 3,
      num_sources_unique: 2,
      rep_url: 'https://example.com/1',
      publishAt: '2026-03-01T12:00:00.000Z',
    }];
    const table = formatSessionTable(rows);
    expect(table).toContain('event_id');
    expect(table).toContain('title');
    expect(table).toContain('topic');
    expect(table).toContain('12345678');
    expect(table).toContain('Test headline');
    expect(table).toContain('POLITICA');
    expect(table).toContain('0.85');
    expect(table).toContain('1 events');
  });

  it('truncates long titles to 80 chars', () => {
    const longTitle = 'A'.repeat(120);
    const rows: SessionRow[] = [{
      event_id: 'aaa', event_id_short: 'aaa',
      title: longTitle,
      topic_key: 'POLITICA', topic_confidence: 0.5,
      num_articles: 1, num_sources_unique: 1,
      rep_url: null, publishAt: null,
    }];
    const table = formatSessionTable(rows);
    // Should contain truncated version, not full 120 chars in one segment
    expect(table).not.toContain('A'.repeat(120));
    expect(table).toContain('A'.repeat(80));
  });
});

// ── formatSessionNdjson ──────────────────────────────────────────

describe('formatSessionNdjson', () => {
  it('outputs one JSON line per row', () => {
    const rows: SessionRow[] = [
      {
        event_id: 'e1', event_id_short: 'e1',
        title: 'A', topic_key: 'POLITICA', topic_confidence: 0.9,
        num_articles: 2, num_sources_unique: 2, rep_url: null, publishAt: null,
      },
      {
        event_id: 'e2', event_id_short: 'e2',
        title: 'B', topic_key: 'CRIMEN_SEGURIDAD', topic_confidence: 0.7,
        num_articles: 1, num_sources_unique: 1, rep_url: null, publishAt: null,
      },
    ];
    const out = formatSessionNdjson(rows);
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).event_id).toBe('e1');
    expect(JSON.parse(lines[1]).topic_key).toBe('CRIMEN_SEGURIDAD');
  });

  it('empty rows produce empty string', () => {
    expect(formatSessionNdjson([])).toBe('');
  });
});

// ── formatSessionOutput dispatch ─────────────────────────────────

describe('formatSessionOutput', () => {
  const row: SessionRow = {
    event_id: 'e1', event_id_short: 'e1',
    title: 'X', topic_key: 'POLITICA', topic_confidence: 0.8,
    num_articles: 1, num_sources_unique: 1, rep_url: null, publishAt: null,
  };

  it('dispatches to table', () => {
    const out = formatSessionOutput([row], 'table');
    expect(out).toContain('event_id'); // header
  });

  it('dispatches to ndjson', () => {
    const out = formatSessionOutput([row], 'ndjson');
    expect(JSON.parse(out.trim()).event_id).toBe('e1');
  });
});

// ── ordering contract (publishAt desc) ───────────────────────────

describe('ordering contract', () => {
  it('buildSessionRow preserves publishAt for sorting', () => {
    const ev1 = makeEvent({ id: 'e-old', publishAt: new Date('2026-03-01T06:00:00Z') });
    const ev2 = makeEvent({ id: 'e-new', publishAt: new Date('2026-03-01T18:00:00Z') });

    // Simulate DB returning in desc order
    const rows = [ev2, ev1].map(buildSessionRow);
    expect(rows[0].event_id).toBe('e-new');
    expect(rows[1].event_id).toBe('e-old');
    // publishAt is preserved as ISO string for downstream sorting
    expect(rows[0].publishAt! > rows[1].publishAt!).toBe(true);
  });
});
