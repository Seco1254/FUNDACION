import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RssDiscoveryJob } from './rss-discovery-job.js';
import { RssFeedEntry } from './feeds.js';
import { EventBus } from '../../../core/event_bus/index.js';

const VALID_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Artículo uno</title>
      <link>https://example.com/articulo-1</link>
      <guid>https://example.com/articulo-1</guid>
      <pubDate>Mon, 10 Mar 2026 12:00:00 GMT</pubDate>
      <description>Descripción uno.</description>
    </item>
    <item>
      <title>Artículo dos</title>
      <link>https://example.com/articulo-2</link>
      <guid>https://example.com/articulo-2</guid>
      <pubDate>Sun, 09 Mar 2026 08:00:00 GMT</pubDate>
      <description>Descripción dos.</description>
    </item>
    <item>
      <title>Artículo tres</title>
      <link>https://example.com/articulo-3</link>
      <pubDate>Sat, 08 Mar 2026 08:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const BROKEN_XML = '<html><body>Not an RSS feed</body></html>';

const testFeed: RssFeedEntry = {
  mediaKey: 'test_media',
  name: 'Test Media',
  feedUrl: 'https://test.com/feed',
  homepage: 'https://test.com',
  sourceType: 'rss',
  enabled: true,
};

function makeArticleRepo() {
  const urls = new Set<string>();
  return {
    findByUrl: vi.fn(async (url: string) => urls.has(url) ? { id: 'existing', url } : null),
    addUrl: (url: string) => urls.add(url),
  };
}

function makeEventBus() {
  const published: Array<{ event_name: string; payload: Record<string, unknown> }> = [];
  return {
    bus: {
      publish: vi.fn(async (envelope: { event_name: string; payload: Record<string, unknown> }) => {
        published.push(envelope);
      }),
      subscribe: vi.fn(),
      setAuditLogWriter: vi.fn(),
    } as unknown as EventBus,
    published,
  };
}

describe('RssDiscoveryJob', () => {
  let articleRepo: ReturnType<typeof makeArticleRepo>;
  let eventBusWrapper: ReturnType<typeof makeEventBus>;
  let job: RssDiscoveryJob;
  let fetchFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    articleRepo = makeArticleRepo();
    eventBusWrapper = makeEventBus();
    fetchFn = vi.fn().mockResolvedValue({ xml: VALID_RSS, latencyMs: 100 });
    job = new RssDiscoveryJob(articleRepo as any, eventBusWrapper.bus, fetchFn);
  });

  it('discovers new articles from valid RSS feed', async () => {
    const result = await job.run([testFeed]);

    expect(result.feedsProcessed).toBe(1);
    expect(result.feedsFailed).toBe(0);
    expect(result.itemsSeen).toBe(3);
    expect(result.itemsNew).toBe(3);
    expect(result.itemsDuplicate).toBe(0);

    // Should emit 3 ArticleDiscovered events
    expect(eventBusWrapper.published).toHaveLength(3);
    expect(eventBusWrapper.published[0].event_name).toBe('ArticleDiscovered');
    expect(eventBusWrapper.published[0].payload.media_key).toBe('test_media');
    expect(eventBusWrapper.published[0].payload.url).toBe('https://example.com/articulo-1');
  });

  it('deduplicates by URL already in DB', async () => {
    articleRepo.addUrl('https://example.com/articulo-1');
    articleRepo.addUrl('https://example.com/articulo-2');

    const result = await job.run([testFeed]);

    expect(result.itemsSeen).toBe(3);
    expect(result.itemsNew).toBe(1);
    expect(result.itemsDuplicate).toBe(2);
    expect(eventBusWrapper.published).toHaveLength(1);
  });

  it('deduplicates within the same run (identity key)', async () => {
    // Feed with duplicate links
    const dupeRss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Mismo artículo</title>
      <link>https://example.com/dupe</link>
    </item>
    <item>
      <title>Mismo artículo repetido</title>
      <link>https://example.com/dupe</link>
    </item>
  </channel>
</rss>`;
    fetchFn.mockResolvedValue({ xml: dupeRss, latencyMs: 50 });

    const result = await job.run([testFeed]);

    expect(result.itemsSeen).toBe(2);
    expect(result.itemsNew).toBe(1);
    expect(result.itemsDuplicate).toBe(1);
  });

  it('does not duplicate across repeated runs', async () => {
    // First run
    const r1 = await job.run([testFeed]);
    expect(r1.itemsNew).toBe(3);

    // Second run — same feed, identity keys already seen in memory
    const r2 = await job.run([testFeed]);
    expect(r2.itemsNew).toBe(0);
    expect(r2.itemsDuplicate).toBe(3);
  });

  it('handles feed fetch error gracefully', async () => {
    fetchFn.mockRejectedValue(new Error('Network timeout'));

    const result = await job.run([testFeed]);

    expect(result.feedsProcessed).toBe(0);
    expect(result.feedsFailed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].mediaKey).toBe('test_media');
    expect(result.errors[0].error).toBe('Network timeout');
    expect(result.itemsSeen).toBe(0);
    expect(result.itemsNew).toBe(0);
  });

  it('handles invalid XML gracefully (no items)', async () => {
    fetchFn.mockResolvedValue({ xml: BROKEN_XML, latencyMs: 50 });

    const result = await job.run([testFeed]);

    expect(result.feedsProcessed).toBe(1);
    expect(result.feedsFailed).toBe(0);
    expect(result.itemsSeen).toBe(0);
    expect(result.itemsNew).toBe(0);
  });

  it('processes multiple feeds independently', async () => {
    const feed2: RssFeedEntry = {
      mediaKey: 'other_media',
      name: 'Other Media',
      feedUrl: 'https://other.com/feed',
      homepage: 'https://other.com',
      sourceType: 'rss',
      enabled: true,
    };

    const otherRss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Otro artículo</title>
      <link>https://other.com/articulo-a</link>
    </item>
  </channel>
</rss>`;

    fetchFn
      .mockResolvedValueOnce({ xml: VALID_RSS, latencyMs: 100 })
      .mockResolvedValueOnce({ xml: otherRss, latencyMs: 50 });

    const result = await job.run([testFeed, feed2]);

    expect(result.feedsProcessed).toBe(2);
    expect(result.itemsNew).toBe(4); // 3 from testFeed + 1 from feed2
    expect(result.byMedia['test_media'].new).toBe(3);
    expect(result.byMedia['other_media'].new).toBe(1);
  });

  it('emits ArticleDiscovered with correct trace source_module=rss', async () => {
    await job.run([testFeed]);

    const envelope = eventBusWrapper.published[0] as any;
    expect(envelope.trace.source_module).toBe('rss');
  });

  it('continues processing when pipeline publish throws', async () => {
    // Make the first publish call throw, rest succeed
    const publishMock = eventBusWrapper.bus.publish as ReturnType<typeof vi.fn>;
    publishMock
      .mockRejectedValueOnce(new Error('Pipeline boom'))
      .mockResolvedValue(undefined);

    const result = await job.run([testFeed]);

    // Should still count all 3 as new (error doesn't block discovery count)
    expect(result.itemsNew).toBe(3);
    // All 3 publish calls were attempted
    expect(publishMock).toHaveBeenCalledTimes(3);
  });

  it('filters non-Spanish articles for el_turbion', async () => {
    const enRss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The struggle for indigenous rights in Colombia</title>
      <link>https://elturbion.com/indigenous-rights</link>
      <description>An article about the fight for indigenous rights.</description>
    </item>
    <item>
      <title>Lucha por los derechos indígenas en Colombia</title>
      <link>https://elturbion.com/derechos-indigenas</link>
      <description>Artículo sobre la lucha por los derechos de los pueblos indígenas.</description>
    </item>
  </channel>
</rss>`;
    fetchFn.mockResolvedValue({ xml: enRss, latencyMs: 50 });

    const turbionFeed: RssFeedEntry = {
      mediaKey: 'el_turbion',
      name: 'El Turbión',
      feedUrl: 'https://elturbion.com/feed',
      homepage: 'https://elturbion.com',
      sourceType: 'rss',
      enabled: true,
    };

    const result = await job.run([turbionFeed]);

    // Only the Spanish article should pass through
    expect(result.itemsSeen).toBe(1);
    expect(result.itemsNew).toBe(1);
    expect(eventBusWrapper.published).toHaveLength(1);
    expect(eventBusWrapper.published[0].payload.url).toBe('https://elturbion.com/derechos-indigenas');
  });

  it('does not filter non-Spanish articles for other media', async () => {
    const enRss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>The struggle for rights</title>
      <link>https://example.com/rights</link>
      <description>An article about the fight for rights.</description>
    </item>
  </channel>
</rss>`;
    fetchFn.mockResolvedValue({ xml: enRss, latencyMs: 50 });

    const result = await job.run([testFeed]);

    // Other media should NOT be filtered by language
    expect(result.itemsSeen).toBe(1);
    expect(result.itemsNew).toBe(1);
  });

  it('resetDedup clears in-memory state', async () => {
    await job.run([testFeed]);

    // After reset, same items should be seen as new again (but DB dedup still applies)
    job.resetDedup();

    // Now items are in seenIdentityKeys again after reset — but articleRepo still has no URLs
    const r2 = await job.run([testFeed]);
    expect(r2.itemsNew).toBe(3); // identity keys cleared, DB has no URLs
  });
});
