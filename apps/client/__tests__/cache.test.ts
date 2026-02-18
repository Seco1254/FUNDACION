import { cache, timeAgo, relativeTime } from '../src/lib/cache';

// Mock storage
jest.mock('../src/lib/storage', () => {
  const store: Record<string, string> = {};
  return {
    storage: {
      get: jest.fn(async (key: string) => {
        const raw = store[key];
        if (!raw) return null;
        return JSON.parse(raw);
      }),
      set: jest.fn(async (key: string, value: any) => {
        store[key] = JSON.stringify(value);
      }),
      remove: jest.fn(async (key: string) => {
        delete store[key];
      }),
    },
  };
});

describe('Cache', () => {
  it('stores and retrieves feed', async () => {
    const feedData = { items: [{ event_id: 'e1', state: 'PUBLISHED' as const, headline: 'Test', t_last: null, published_at: null, cover_image_url: null }], next_cursor: null };
    await cache.setFeed(feedData);
    const cached = await cache.getFeed();
    expect(cached).not.toBeNull();
    expect(cached!.data.items[0].event_id).toBe('e1');
    expect(cached!.timestamp).toBeGreaterThan(0);
  });

  it('stores and retrieves event', async () => {
    const eventData = {
      event: { id: 'e1', state: 'PUBLISHED' as const, t0: null, t_last: null, publish_at: null, published_at: null, closed_at: null, canonical_event_id: null },
      latest_version: null,
      media_tabs: [],
      overview: { status: 'NOT_READY' },
      bias: { media_level: [], article_level: [] },
      topics: { top_topics: [], emergent: [] },
      topics_heatmap: [],
      subevents: [],
      heatmap: {},
    };
    await cache.setEvent('e1', eventData);
    const cached = await cache.getEvent('e1');
    expect(cached).not.toBeNull();
    expect(cached!.data.event.id).toBe('e1');
  });

  it('stores and retrieves bias', async () => {
    const biasData = {
      media_key: 'eltiempo',
      media_level: null,
      article_level: [],
    };
    await cache.setBias('e1', 'eltiempo', biasData);
    const cached = await cache.getBias('e1', 'eltiempo');
    expect(cached).not.toBeNull();
    expect(cached!.data.media_key).toBe('eltiempo');
  });

  it('returns null for missing cache', async () => {
    const cached = await cache.getFeed('nonexistent-cursor');
    expect(cached).toBeNull();
  });
});

describe('timeAgo', () => {
  it('returns "hace un momento" for recent timestamps', () => {
    expect(timeAgo(Date.now() - 5000)).toBe('hace un momento');
  });

  it('returns minutes for <60min', () => {
    const result = timeAgo(Date.now() - 5 * 60 * 1000);
    expect(result).toBe('hace 5 min');
  });

  it('returns hours for <24h', () => {
    const result = timeAgo(Date.now() - 3 * 60 * 60 * 1000);
    expect(result).toBe('hace 3h');
  });

  it('returns days for >24h', () => {
    const result = timeAgo(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(result).toBe('hace 2d');
  });
});

describe('relativeTime', () => {
  it('returns null for null input', () => {
    expect(relativeTime(null)).toBeNull();
  });

  it('returns null for invalid date', () => {
    expect(relativeTime('not-a-date')).toBeNull();
  });

  it('returns relative time for valid ISO string', () => {
    const recent = new Date(Date.now() - 60000).toISOString();
    const result = relativeTime(recent);
    expect(result).toBe('hace 1 min');
  });
});
