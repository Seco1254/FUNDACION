import { describe, it, expect, beforeEach } from 'vitest';
import { kMeans2, withinCohesion, SplitDetector } from './split-detector.js';
import { cosineSimilarity, computeCentroid } from './similarity.js';

// ── Test vectors ──

/** Create a unit vector with energy concentrated in specific buckets */
function makeClusterVec(cluster: 'A' | 'B', variation: number): number[] {
  const vec = new Array(256).fill(0);
  if (cluster === 'A') {
    // Cluster A: energy in low buckets [0-50]
    vec[0] = 1.0;
    vec[10 + (variation % 40)] = 0.5;
    vec[20 + (variation * 3 % 30)] = 0.3;
  } else {
    // Cluster B: energy in high buckets [128-255]
    vec[128] = 1.0;
    vec[140 + (variation % 40)] = 0.5;
    vec[200 + (variation * 3 % 50)] = 0.3;
  }
  // L2 normalize
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

/** Single cohesive cluster: all vectors near the same point */
function makeCohesiveVec(variation: number): number[] {
  const vec = new Array(256).fill(0);
  vec[50] = 1.0;
  vec[51 + (variation % 5)] = 0.4 + variation * 0.01;
  vec[55] = 0.2;
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / mag);
}

describe('kMeans2', () => {
  it('separates two clear clusters', () => {
    const vectors = [
      makeClusterVec('A', 0),
      makeClusterVec('A', 1),
      makeClusterVec('A', 2),
      makeClusterVec('B', 0),
      makeClusterVec('B', 1),
      makeClusterVec('B', 2),
    ];
    const { clusters } = kMeans2(vectors);
    const [cA, cB] = clusters;

    // Each cluster should have 3 items
    expect(cA.length).toBe(3);
    expect(cB.length).toBe(3);

    // All A vectors should be in same cluster
    const aInCluster0 = [0, 1, 2].every((i) => cA.includes(i));
    const aInCluster1 = [0, 1, 2].every((i) => cB.includes(i));
    expect(aInCluster0 || aInCluster1).toBe(true);
  });

  it('handles single vector', () => {
    const { clusters } = kMeans2([makeClusterVec('A', 0)]);
    expect(clusters[0].length).toBe(1);
    expect(clusters[1].length).toBe(0);
  });

  it('handles two vectors', () => {
    const vectors = [makeClusterVec('A', 0), makeClusterVec('B', 0)];
    const { clusters } = kMeans2(vectors);
    expect(clusters[0].length + clusters[1].length).toBe(2);
  });
});

describe('withinCohesion', () => {
  it('cohesive cluster has low within-cohesion distance', () => {
    const vectors = [
      makeCohesiveVec(0),
      makeCohesiveVec(1),
      makeCohesiveVec(2),
      makeCohesiveVec(3),
    ];
    const centroid = computeCentroid(vectors);
    const cohesion = withinCohesion(vectors, centroid);
    // Cohesive cluster → small avg distance
    expect(cohesion).toBeLessThan(0.1);
  });

  it('spread cluster has higher within-cohesion distance', () => {
    const vectors = [
      makeClusterVec('A', 0),
      makeClusterVec('B', 0),
      makeClusterVec('A', 5),
      makeClusterVec('B', 5),
    ];
    const centroid = computeCentroid(vectors);
    const cohesion = withinCohesion(vectors, centroid);
    // Mixed cluster → larger avg distance
    expect(cohesion).toBeGreaterThan(0.1);
  });

  it('returns 0 for empty vectors', () => {
    expect(withinCohesion([], [0])).toBe(0);
  });
});

describe('SplitDetector integration', () => {
  // Mock repos for split detector test
  function makeMockRepos(articles: any[]) {
    const events: any[] = [];
    const links: Map<string, Set<string>> = new Map();

    // Initialize with the articles in the event
    links.set('evt-mixed', new Set(articles.map((a) => a.id)));

    const eventRepo = {
      findArticlesForEvent: async (eventId: string) => {
        const artIds = links.get(eventId);
        if (!artIds) return [];
        return articles.filter((a) => artIds.has(a.id));
      },
      countArticlesForEvent: async (eventId: string) => {
        return links.get(eventId)?.size ?? 0;
      },
      create: async (data: any) => {
        const newEvent = { id: `evt-new-${events.length}`, ...data };
        events.push(newEvent);
        links.set(newEvent.id, new Set());
        return newEvent;
      },
      linkArticle: async (eventId: string, articleId: string) => {
        if (!links.has(eventId)) links.set(eventId, new Set());
        links.get(eventId)!.add(articleId);
      },
      unlinkArticle: async (eventId: string, articleId: string) => {
        links.get(eventId)?.delete(articleId);
      },
    };

    const auditEntries: any[] = [];
    const auditWriter = {
      write: async (entry: any) => { auditEntries.push(entry); },
    };

    const publishedEvents: any[] = [];
    const eventBus = {
      publish: async (envelope: any) => { publishedEvents.push(envelope); },
    };

    return { eventRepo, auditWriter, eventBus, events, links, auditEntries, publishedEvents };
  }

  beforeEach(() => {
    SplitDetector.clearCooldowns();
  });

  it('splits event with two clear clusters', async () => {
    const articles = [
      { id: 'a1', title: 'T1', snippet: 'S1', embeddingVec: makeClusterVec('A', 0), mediaId: 'm1' },
      { id: 'a2', title: 'T2', snippet: 'S2', embeddingVec: makeClusterVec('A', 1), mediaId: 'm1' },
      { id: 'a3', title: 'T3', snippet: 'S3', embeddingVec: makeClusterVec('B', 0), mediaId: 'm2' },
      { id: 'a4', title: 'T4', snippet: 'S4', embeddingVec: makeClusterVec('B', 1), mediaId: 'm2' },
    ];

    const mocks = makeMockRepos(articles);
    const detector = new SplitDetector(
      mocks.eventRepo as any,
      {} as any,
      mocks.eventBus as any,
      mocks.auditWriter as any,
    );

    const result = await detector.checkAndSplit('evt-mixed', 'trace-1');

    expect(result.didSplit).toBe(true);
    expect(result.newEventId).toBeDefined();
    expect(result.movedArticleCount).toBe(2);
    expect(result.separation).toBeGreaterThanOrEqual(0.18);

    // Verify articles were moved
    const oldEventArticles = mocks.links.get('evt-mixed')!;
    expect(oldEventArticles.size).toBe(2);

    // Verify audit was written
    expect(mocks.auditEntries.length).toBe(1);
    expect(mocks.auditEntries[0].action).toBe('EVENT_SPLIT');
    expect(mocks.auditEntries[0].data.reason).toBe('EMBED_CLUSTER_K2');

    // Verify event published
    expect(mocks.publishedEvents.some((e: any) => e.event_name === 'EventSplitCreated')).toBe(true);
  });

  it('does NOT split cohesive event (single cluster)', async () => {
    const articles = [
      { id: 'a1', title: 'T1', snippet: 'S1', embeddingVec: makeCohesiveVec(0), mediaId: 'm1' },
      { id: 'a2', title: 'T2', snippet: 'S2', embeddingVec: makeCohesiveVec(1), mediaId: 'm1' },
      { id: 'a3', title: 'T3', snippet: 'S3', embeddingVec: makeCohesiveVec(2), mediaId: 'm2' },
      { id: 'a4', title: 'T4', snippet: 'S4', embeddingVec: makeCohesiveVec(3), mediaId: 'm2' },
    ];

    const mocks = makeMockRepos(articles);
    const detector = new SplitDetector(
      mocks.eventRepo as any,
      {} as any,
      mocks.eventBus as any,
      mocks.auditWriter as any,
    );

    const result = await detector.checkAndSplit('evt-mixed', 'trace-2');

    expect(result.didSplit).toBe(false);
    // No articles moved, no audit entries
    expect(mocks.links.get('evt-mixed')!.size).toBe(4);
    expect(mocks.auditEntries.length).toBe(0);
  });

  it('does NOT split when article count < SPLIT_MIN_ARTICLES', async () => {
    const articles = [
      { id: 'a1', title: 'T1', snippet: 'S1', embeddingVec: makeClusterVec('A', 0), mediaId: 'm1' },
      { id: 'a2', title: 'T2', snippet: 'S2', embeddingVec: makeClusterVec('B', 0), mediaId: 'm2' },
    ];

    const mocks = makeMockRepos(articles);
    const detector = new SplitDetector(
      mocks.eventRepo as any,
      {} as any,
      mocks.eventBus as any,
      mocks.auditWriter as any,
    );

    const result = await detector.checkAndSplit('evt-mixed', 'trace-3');
    expect(result.didSplit).toBe(false);
  });

  it('respects cooldown — second check within cooldown returns false', async () => {
    const articles = [
      { id: 'a1', title: 'T1', snippet: 'S1', embeddingVec: makeClusterVec('A', 0), mediaId: 'm1' },
      { id: 'a2', title: 'T2', snippet: 'S2', embeddingVec: makeClusterVec('A', 1), mediaId: 'm1' },
      { id: 'a3', title: 'T3', snippet: 'S3', embeddingVec: makeClusterVec('B', 0), mediaId: 'm2' },
      { id: 'a4', title: 'T4', snippet: 'S4', embeddingVec: makeClusterVec('B', 1), mediaId: 'm2' },
    ];

    const mocks = makeMockRepos(articles);
    const detector = new SplitDetector(
      mocks.eventRepo as any,
      {} as any,
      mocks.eventBus as any,
      mocks.auditWriter as any,
    );

    // First call: splits
    const result1 = await detector.checkAndSplit('evt-mixed', 'trace-4');
    expect(result1.didSplit).toBe(true);

    // Re-add articles to simulate next check (they were moved, but for cooldown test)
    // The cooldown should prevent checking again regardless
    const result2 = await detector.checkAndSplit('evt-mixed', 'trace-5');
    expect(result2.didSplit).toBe(false);
  });
});
