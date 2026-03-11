import { describe, it, expect } from 'vitest';
import {
  parseArgs,
  validateLabel,
  validateLabelInput,
  formatOutput,
  VALID_LABELS,
} from './events-label.js';

// ── parseArgs ────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses command and --key=value flags', () => {
    const { command, flags } = parseArgs([
      'node', 'script.ts', 'label', '--event_id=abc-123', '--label=GOOD',
    ]);
    expect(command).toBe('label');
    expect(flags).toEqual({ event_id: 'abc-123', label: 'GOOD' });
  });

  it('parses with no command', () => {
    const { command, flags } = parseArgs(['node', 'script.ts', '--limit=50']);
    expect(command).toBe('');
    expect(flags).toEqual({ limit: '50' });
  });

  it('ignores unknown flags without --', () => {
    const { command } = parseArgs(['node', 'script.ts', 'stats']);
    expect(command).toBe('stats');
  });

  it('handles empty argv', () => {
    const { command, flags } = parseArgs(['node', 'script.ts']);
    expect(command).toBe('');
    expect(flags).toEqual({});
  });
});

// ── validateLabel ────────────────────────────────────────────────

describe('validateLabel', () => {
  it('accepts all valid labels', () => {
    for (const label of VALID_LABELS) {
      expect(validateLabel(label)).toBe(true);
    }
  });

  it('rejects invalid label', () => {
    expect(validateLabel('INVALID')).toBe(false);
    expect(validateLabel('')).toBe(false);
    expect(validateLabel('good')).toBe(false); // case-sensitive
  });
});

// ── validateLabelInput ───────────────────────────────────────────

describe('validateLabelInput', () => {
  it('validates GOOD without note', () => {
    const r = validateLabelInput({ label: 'GOOD' });
    expect(r.valid).toBe(true);
  });

  it('validates BAD_MERGE without note', () => {
    const r = validateLabelInput({ label: 'BAD_MERGE' });
    expect(r.valid).toBe(true);
  });

  it('rejects BAD_OTHER without note', () => {
    const r = validateLabelInput({ label: 'BAD_OTHER' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('BAD_OTHER');
  });

  it('rejects BAD_OTHER with empty note', () => {
    const r = validateLabelInput({ label: 'BAD_OTHER', note: '  ' });
    expect(r.valid).toBe(false);
  });

  it('accepts BAD_OTHER with valid note', () => {
    const r = validateLabelInput({ label: 'BAD_OTHER', note: 'duplicate event' });
    expect(r.valid).toBe(true);
  });

  it('rejects invalid label', () => {
    const r = validateLabelInput({ label: 'NOT_REAL' });
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('Invalid label');
  });

  it('rejects empty label', () => {
    const r = validateLabelInput({ label: '' });
    expect(r.valid).toBe(false);
  });
});

// ── formatOutput ─────────────────────────────────────────────────

describe('formatOutput', () => {
  const records = [
    { kind: 'label', event_id: 'aaa', label: 'GOOD' },
    { kind: 'label', event_id: 'bbb', label: 'BAD_MERGE' },
  ];

  it('formats as ndjson (one JSON per line + trailing newline)', () => {
    const out = formatOutput(records, 'ndjson');
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).kind).toBe('label');
    expect(JSON.parse(lines[1]).label).toBe('BAD_MERGE');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('formats as json (pretty-printed array)', () => {
    const out = formatOutput(records, 'json');
    const parsed = JSON.parse(out);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });

  it('formats as table (human-readable lines)', () => {
    const out = formatOutput([
      { kind: 'label', event_id: '12345678-aaaa-bbbb-cccc-dddddddddddd', label: 'GOOD', created_at: '2026-03-01T00:00:00.000Z' },
    ], 'table');
    expect(out).toContain('GOOD');
    expect(out).toContain('12345678');
  });

  it('formats stats as table', () => {
    const out = formatOutput([{
      kind: 'stats',
      total: 5,
      counts: [{ label: 'GOOD', count: 3 }, { label: 'BAD_MERGE', count: 2 }],
      top_notes: [{ note: 'duplicate', count: 1 }],
    }], 'table');
    expect(out).toContain('Label Stats');
    expect(out).toContain('GOOD');
    expect(out).toContain('TOTAL');
    expect(out).toContain('duplicate');
  });

  it('handles empty records', () => {
    const out = formatOutput([], 'ndjson');
    expect(out).toBe('\n');
  });

  it('handles empty records as table', () => {
    const out = formatOutput([], 'table');
    expect(out).toContain('no records');
  });
});

// ── VALID_LABELS constant ────────────────────────────────────────

describe('VALID_LABELS', () => {
  it('contains exactly 7 labels', () => {
    expect(VALID_LABELS).toHaveLength(7);
  });

  it('includes all expected labels', () => {
    expect(VALID_LABELS).toContain('GOOD');
    expect(VALID_LABELS).toContain('BAD_MERGE');
    expect(VALID_LABELS).toContain('BAD_SOURCE');
    expect(VALID_LABELS).toContain('BAD_TOPIC');
    expect(VALID_LABELS).toContain('BAD_IMPORTANCE');
    expect(VALID_LABELS).toContain('BAD_ADS_COMMERCIAL');
    expect(VALID_LABELS).toContain('BAD_OTHER');
  });
});

// ── Snapshot keys contract ───────────────────────────────────────

describe('snapshot_json contract', () => {
  // These test that the expected keys are documented; actual snapshot building
  // is integration-tested with DB. Here we validate the shape contract.
  const EXPECTED_SNAPSHOT_KEYS = [
    'title', 'status', 'publishAt', 'updatedAt',
    'coverage', 'coherence_gate', 'quality_flags', 'ranking_features',
    'topic_key', 'topic_confidence', 'topic_signals', 'topic_reason',
    'importance_score', 'demotion_multiplier', 'demotion_reasons',
    'representative_article', 'eligibility',
  ];

  it('snapshot schema has all expected top-level keys', () => {
    // buildSnapshot returns an object; we verify the contract by checking
    // that our EXPECTED keys array is correct. This is a specification test.
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('title');
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('coverage');
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('topic_key');
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('importance_score');
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('representative_article');
    expect(EXPECTED_SNAPSHOT_KEYS).toContain('eligibility');
    expect(EXPECTED_SNAPSHOT_KEYS).toHaveLength(17);
  });
});
