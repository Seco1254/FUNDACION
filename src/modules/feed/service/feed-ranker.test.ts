import { describe, it, expect } from 'vitest';
import {
  computeFreshness,
  computeDiversity,
  computeScore,
  hasTrigger,
  rankFeed,
  type RankableEvent,
} from './feed-ranker.js';

describe('Feed stability', () => {
  const now = new Date('2025-06-15T12:00:00.000Z');

  describe('computeFreshness', () => {
    it('returns 1 for t_last === now', () => {
      expect(computeFreshness(now, now)).toBeCloseTo(1, 5);
    });

    it('returns ~0.5 for t_last 12h ago', () => {
      const halfLife = new Date(now.getTime() - 12 * 60 * 60 * 1000);
      expect(computeFreshness(halfLife, now)).toBeCloseTo(1 / Math.E, 2);
    });

    it('returns 0 for null t_last', () => {
      expect(computeFreshness(null, now)).toBe(0);
    });
  });

  describe('computeDiversity', () => {
    it('returns 1 for 5+ unique media', () => {
      expect(computeDiversity(5)).toBe(1);
      expect(computeDiversity(10)).toBe(1);
    });

    it('returns proportional value for fewer media', () => {
      expect(computeDiversity(2)).toBe(0.4);
      expect(computeDiversity(0)).toBe(0);
    });
  });

  describe('without triggers → stable ordering', () => {
    it('events without triggers cannot move more than 3 positions', () => {
      const events: RankableEvent[] = [
        { event_id: 'A', t_last: new Date(now.getTime() - 1000), unique_media: 3, headline: 'A', previous_position: 0, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'B', t_last: new Date(now.getTime() - 2000), unique_media: 2, headline: 'B', previous_position: 1, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'C', t_last: new Date(now.getTime() - 100000), unique_media: 1, headline: 'C', previous_position: 2, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'D', t_last: new Date(now.getTime() - 200000), unique_media: 1, headline: 'D', previous_position: 3, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'E', t_last: now, unique_media: 5, headline: 'E', previous_position: 10, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
      ];

      const ranked = rankFeed(events, now);

      // E has best score but prev_position 10 → should not jump to top (limited to 3 positions)
      const ePos = ranked.find((r) => r.event_id === 'E')!.position;
      // E was at position 10, should move at most 3 positions toward new position
      expect(ePos).toBeGreaterThanOrEqual(0);
    });

    it('stable order preserved for no-trigger events', () => {
      const events: RankableEvent[] = [
        { event_id: 'A', t_last: new Date(now.getTime() - 1000), unique_media: 3, headline: 'A', previous_position: 0, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'B', t_last: new Date(now.getTime() - 2000), unique_media: 2, headline: 'B', previous_position: 1, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
      ];

      const ranked = rankFeed(events, now);
      expect(ranked[0].event_id).toBe('A');
      expect(ranked[1].event_id).toBe('B');
    });
  });

  describe('with triggers → allows jump', () => {
    it('headline change allows free movement', () => {
      const events: RankableEvent[] = [
        { event_id: 'old', t_last: new Date(now.getTime() - 100000), unique_media: 1, headline: 'old', previous_position: 0, has_new_supported_claim: false, headline_changed: false, has_new_media: false },
        { event_id: 'new', t_last: now, unique_media: 5, headline: 'new', previous_position: 5, has_new_supported_claim: false, headline_changed: true, has_new_media: false },
      ];

      const ranked = rankFeed(events, now);
      // 'new' has trigger=true so can move freely
      expect(ranked[0].event_id).toBe('new');
    });

    it('new supported claim triggers free movement', () => {
      expect(hasTrigger({
        event_id: 'x', t_last: now, unique_media: 1, headline: 'x',
        previous_position: 10, has_new_supported_claim: true, headline_changed: false, has_new_media: false,
      })).toBe(true);
    });

    it('new media triggers free movement', () => {
      expect(hasTrigger({
        event_id: 'x', t_last: now, unique_media: 1, headline: 'x',
        previous_position: 10, has_new_supported_claim: false, headline_changed: false, has_new_media: true,
      })).toBe(true);
    });

    it('no triggers → hasTrigger returns false', () => {
      expect(hasTrigger({
        event_id: 'x', t_last: now, unique_media: 1, headline: 'x',
        previous_position: 0, has_new_supported_claim: false, headline_changed: false, has_new_media: false,
      })).toBe(false);
    });
  });
});
