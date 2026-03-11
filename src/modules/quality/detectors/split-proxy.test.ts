import { describe, it, expect } from 'vitest';
import { detectSplitPairs, EventForSplit } from './split-proxy.js';

function makeVec(dim: number, idx: number): number[] {
  const v = new Array(dim).fill(0);
  v[idx % dim] = 1;
  return v;
}

describe('detectSplitPairs', () => {
  it('flags two events with identical centroids and overlapping entities', () => {
    const events: EventForSplit[] = [
      {
        event_id: 'evt-1',
        centroid: makeVec(8, 0),
        entities: new Set(['petro', 'colombia', 'reforma']),
      },
      {
        event_id: 'evt-2',
        centroid: makeVec(8, 0),
        entities: new Set(['petro', 'colombia', 'tributaria']),
      },
    ];

    const pairs = detectSplitPairs(events, 0.9, 0.1);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].event_a).toBe('evt-1');
    expect(pairs[0].event_b).toBe('evt-2');
    expect(pairs[0].centroid_sim).toBeCloseTo(1.0);
    expect(pairs[0].entity_overlap).toBeGreaterThan(0);
  });

  it('does NOT flag events with different centroids', () => {
    const events: EventForSplit[] = [
      {
        event_id: 'evt-1',
        centroid: makeVec(8, 0),
        entities: new Set(['petro', 'colombia']),
      },
      {
        event_id: 'evt-2',
        centroid: makeVec(8, 4),
        entities: new Set(['petro', 'colombia']),
      },
    ];

    const pairs = detectSplitPairs(events, 0.9, 0.1);
    expect(pairs).toHaveLength(0);
  });

  it('does NOT flag events with similar centroids but no entity overlap', () => {
    const events: EventForSplit[] = [
      {
        event_id: 'evt-1',
        centroid: makeVec(8, 0),
        entities: new Set(['petro', 'colombia']),
      },
      {
        event_id: 'evt-2',
        centroid: makeVec(8, 0),
        entities: new Set(['trump', 'estados unidos']),
      },
    ];

    const pairs = detectSplitPairs(events, 0.9, 0.3);
    expect(pairs).toHaveLength(0);
  });

  it('handles empty event list', () => {
    expect(detectSplitPairs([])).toHaveLength(0);
  });

  it('handles single event', () => {
    const events: EventForSplit[] = [{
      event_id: 'evt-1',
      centroid: makeVec(8, 0),
      entities: new Set(['x']),
    }];
    expect(detectSplitPairs(events)).toHaveLength(0);
  });

  it('skips events with empty centroids', () => {
    const events: EventForSplit[] = [
      { event_id: 'evt-1', centroid: [], entities: new Set(['x']) },
      { event_id: 'evt-2', centroid: makeVec(8, 0), entities: new Set(['x']) },
    ];
    expect(detectSplitPairs(events, 0.1, 0.1)).toHaveLength(0);
  });

  it('detects multiple split pairs among several events', () => {
    const events: EventForSplit[] = [
      { event_id: 'evt-1', centroid: makeVec(8, 0), entities: new Set(['a', 'b']) },
      { event_id: 'evt-2', centroid: makeVec(8, 0), entities: new Set(['a', 'b']) },
      { event_id: 'evt-3', centroid: makeVec(8, 0), entities: new Set(['a', 'b']) },
      { event_id: 'evt-4', centroid: makeVec(8, 4), entities: new Set(['x', 'y']) },
    ];

    const pairs = detectSplitPairs(events, 0.9, 0.1);
    // evt-1/2, evt-1/3, evt-2/3 should be flagged; evt-4 is different direction
    expect(pairs).toHaveLength(3);
  });
});
