import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Cache } from './cache.js';

describe('Cache LRU+TTL', () => {
  it('stores and retrieves values', () => {
    const cache = new Cache();
    cache.set('key1', { data: 'hello' });
    expect(cache.get('key1')).toEqual({ data: 'hello' });
  });

  it('returns undefined for missing keys', () => {
    const cache = new Cache();
    expect(cache.get('missing')).toBeUndefined();
  });

  it('expires entries after TTL', () => {
    vi.useFakeTimers();
    const cache = new Cache({ maxEntries: 100, defaultTtlMs: 1000 });
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');

    vi.advanceTimersByTime(1001);
    expect(cache.get('key1')).toBeUndefined();
    vi.useRealTimers();
  });

  it('respects per-key TTL override', () => {
    vi.useFakeTimers();
    const cache = new Cache({ maxEntries: 100, defaultTtlMs: 10000 });
    cache.set('short', 'value', 500);
    cache.set('long', 'value', 5000);

    vi.advanceTimersByTime(600);
    expect(cache.get('short')).toBeUndefined();
    expect(cache.get('long')).toBe('value');
    vi.useRealTimers();
  });

  it('evicts oldest entry when maxEntries reached', () => {
    const cache = new Cache({ maxEntries: 3, defaultTtlMs: 60000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    cache.set('d', 4); // should evict 'a'

    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('d')).toBe(4);
    expect(cache.size).toBe(3);
  });

  it('LRU: accessing entry refreshes its position', () => {
    const cache = new Cache({ maxEntries: 3, defaultTtlMs: 60000 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);

    // Access 'a' to make it fresh
    cache.get('a');

    cache.set('d', 4); // should evict 'b' (oldest untouched)

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.get('d')).toBe(4);
  });

  it('del removes a specific key', () => {
    const cache = new Cache();
    cache.set('key1', 'val');
    expect(cache.del('key1')).toBe(true);
    expect(cache.get('key1')).toBeUndefined();
    expect(cache.del('nonexistent')).toBe(false);
  });

  it('delByPrefix removes all matching keys', () => {
    const cache = new Cache();
    cache.set('feed:global:', 'a');
    cache.set('feed:eco:', 'b');
    cache.set('event:123', 'c');

    const deleted = cache.delByPrefix('feed:');
    expect(deleted).toBe(2);
    expect(cache.get('feed:global:')).toBeUndefined();
    expect(cache.get('event:123')).toBe('c');
  });

  it('clear removes all entries', () => {
    const cache = new Cache();
    cache.set('a', 1);
    cache.set('b', 2);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
