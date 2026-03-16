import { describe, it, expect } from 'vitest';
import { RSS_FEEDS, getEnabledFeeds } from './feeds.js';

describe('RSS feed registry', () => {
  it('has exactly 4 feeds', () => {
    expect(RSS_FEEDS).toHaveLength(4);
  });

  it('all feeds have required fields', () => {
    for (const feed of RSS_FEEDS) {
      expect(feed.mediaKey).toBeTruthy();
      expect(feed.name).toBeTruthy();
      expect(feed.feedUrl).toMatch(/^https?:\/\//);
      expect(feed.homepage).toMatch(/^https?:\/\//);
      expect(feed.sourceType).toBe('rss');
      expect(typeof feed.enabled).toBe('boolean');
    }
  });

  it('has the 4 expected media keys', () => {
    const keys = RSS_FEEDS.map((f) => f.mediaKey);
    expect(keys).toContain('servindi');
    expect(keys).toContain('prensa_rural');
    expect(keys).toContain('el_turbion');
    expect(keys).toContain('la_cola_de_rata');
  });

  it('getEnabledFeeds returns only enabled feeds', () => {
    const enabled = getEnabledFeeds();
    expect(enabled.length).toBeGreaterThan(0);
    for (const feed of enabled) {
      expect(feed.enabled).toBe(true);
    }
  });

  it('servindi is disabled by default', () => {
    const servindi = RSS_FEEDS.find((f) => f.mediaKey === 'servindi');
    expect(servindi).toBeDefined();
    expect(servindi!.enabled).toBe(false);
  });

  it('getEnabledFeeds does not include servindi', () => {
    const enabled = getEnabledFeeds();
    const keys = enabled.map((f) => f.mediaKey);
    expect(keys).not.toContain('servindi');
  });

  it('prensa_rural has geoFilter enabled', () => {
    const pr = RSS_FEEDS.find((f) => f.mediaKey === 'prensa_rural');
    expect(pr!.geoFilter).toBe(true);
  });

  it('el_turbion does not have geoFilter', () => {
    const et = RSS_FEEDS.find((f) => f.mediaKey === 'el_turbion');
    expect(et!.geoFilter).toBeFalsy();
  });

  it('la_cola_de_rata does not have geoFilter', () => {
    const lcr = RSS_FEEDS.find((f) => f.mediaKey === 'la_cola_de_rata');
    expect(lcr!.geoFilter).toBeFalsy();
  });
});
