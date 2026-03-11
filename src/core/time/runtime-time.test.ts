import { describe, it, expect, vi, afterEach } from 'vitest';
import { getRuntimeNow, addMs, getRuntimeTzDebug } from './runtime-time.js';

describe('runtime-time helpers', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getRuntimeNow', () => {
    it('returns a Date close to Date.now()', () => {
      const before = Date.now();
      const result = getRuntimeNow();
      const after = Date.now();

      expect(result).toBeInstanceOf(Date);
      expect(result.getTime()).toBeGreaterThanOrEqual(before);
      expect(result.getTime()).toBeLessThanOrEqual(after);
    });

    it('returns distinct Date objects on successive calls', () => {
      const a = getRuntimeNow();
      const b = getRuntimeNow();
      expect(a).not.toBe(b); // different object identity
    });
  });

  describe('addMs', () => {
    it('adds positive milliseconds', () => {
      const base = new Date('2025-06-15T12:00:00.000Z');
      const result = addMs(base, 5 * 60 * 1000); // +5 min
      expect(result.getTime()).toBe(base.getTime() + 5 * 60 * 1000);
    });

    it('subtracts when ms is negative', () => {
      const base = new Date('2025-06-15T12:00:00.000Z');
      const result = addMs(base, -7 * 24 * 60 * 60 * 1000); // -7 days
      expect(result.getTime()).toBe(base.getTime() - 7 * 24 * 60 * 60 * 1000);
    });

    it('does not mutate the original date', () => {
      const base = new Date('2025-06-15T12:00:00.000Z');
      const originalMs = base.getTime();
      addMs(base, 1000);
      expect(base.getTime()).toBe(originalMs);
    });

    it('returns a new Date object', () => {
      const base = new Date();
      const result = addMs(base, 0);
      expect(result).not.toBe(base);
      expect(result.getTime()).toBe(base.getTime());
    });
  });

  describe('getRuntimeTzDebug', () => {
    it('returns tzOffsetMin as a number', () => {
      const debug = getRuntimeTzDebug();
      expect(typeof debug.tzOffsetMin).toBe('number');
    });

    it('returns tz as string or null', () => {
      const debug = getRuntimeTzDebug();
      expect(debug.tz === null || typeof debug.tz === 'string').toBe(true);
    });

    it('returns localIso as a string with offset', () => {
      const debug = getRuntimeTzDebug();
      // localIso should match pattern: YYYY-MM-DDTHH:MM:SS+HH:MM or -HH:MM
      expect(debug.localIso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    });

    it('localIso represents approximately the same instant as now', () => {
      const before = Date.now();
      const debug = getRuntimeTzDebug();
      const after = Date.now();
      // Parse the localIso back — Date constructor handles offset correctly
      const parsed = new Date(debug.localIso).getTime();
      // Allow 2 seconds tolerance for slow CI
      expect(parsed).toBeGreaterThanOrEqual(before - 2000);
      expect(parsed).toBeLessThanOrEqual(after + 2000);
    });
  });
});
