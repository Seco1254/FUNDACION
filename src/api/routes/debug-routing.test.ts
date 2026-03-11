import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugRoutingRoutes } from './debug-routing.js';

function makePrisma(articles: any[]) {
  return {
    article: {
      findMany: vi.fn().mockResolvedValue(articles),
    },
  } as any;
}

function makeArticle(
  routingDecision: string | null,
  contentType: string | null,
  textContentLen: number,
) {
  return { routingDecision, contentType, textContentLen };
}

describe('debug-routing routes — summary', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it('returns correct response shape', async () => {
    const prisma = makePrisma([
      makeArticle('NEWS', 'news', 1200),
      makeArticle('NON_NEWS', 'institutional_static', 180),
      makeArticle('LOW_CONFIDENCE', 'opinion', 900),
    ]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body).toHaveProperty('total_articles', 3);
    expect(body).toHaveProperty('counts_by_routing_decision');
    expect(body).toHaveProperty('counts_by_content_type');
    expect(body).toHaveProperty('avg_text_length_by_bucket');
  });

  it('counts routing decisions correctly', async () => {
    const prisma = makePrisma([
      makeArticle('NEWS', 'news', 1000),
      makeArticle('NEWS', 'news', 1500),
      makeArticle('NON_NEWS', 'institutional_static', 200),
      makeArticle('LOW_CONFIDENCE', 'institutional', 800),
    ]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    const body = res.json();

    expect(body.counts_by_routing_decision.NEWS).toBe(2);
    expect(body.counts_by_routing_decision.NON_NEWS).toBe(1);
    expect(body.counts_by_routing_decision.LOW_CONFIDENCE).toBe(1);
  });

  it('counts content types correctly', async () => {
    const prisma = makePrisma([
      makeArticle('NEWS', 'news', 1000),
      makeArticle('NEWS', 'news', 1500),
      makeArticle('NON_NEWS', 'institutional_static', 200),
      makeArticle('LOW_CONFIDENCE', 'opinion', 800),
    ]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    const body = res.json();

    expect(body.counts_by_content_type.news).toBe(2);
    expect(body.counts_by_content_type.institutional_static).toBe(1);
    expect(body.counts_by_content_type.opinion).toBe(1);
  });

  it('computes avg text length by bucket', async () => {
    const prisma = makePrisma([
      makeArticle('NEWS', 'news', 1000),
      makeArticle('NEWS', 'news', 2000),
      makeArticle('NON_NEWS', 'institutional_static', 100),
    ]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    const body = res.json();

    expect(body.avg_text_length_by_bucket.NEWS).toBe(1500);
    expect(body.avg_text_length_by_bucket.NON_NEWS).toBe(100);
  });

  it('handles null routing_decision', async () => {
    const prisma = makePrisma([
      makeArticle(null, 'news', 1000),
    ]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    const body = res.json();

    expect(body.counts_by_routing_decision.null).toBe(1);
  });

  it('handles empty results', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary' });
    const body = res.json();

    expect(body.total_articles).toBe(0);
    expect(body.counts_by_routing_decision).toEqual({});
    expect(body.counts_by_content_type).toEqual({});
    expect(body.avg_text_length_by_bucket).toEqual({});
  });

  it('rejects invalid limit', async () => {
    app = Fastify();
    app.register(debugRoutingRoutes(makePrisma([])));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/routing/summary?limit=abc' });
    expect(res.statusCode).toBe(400);
  });

  it('passes limit to prisma findMany', async () => {
    const prisma = makePrisma([]);

    app = Fastify();
    app.register(debugRoutingRoutes(prisma));

    await app.inject({ method: 'GET', url: '/v1/debug/routing/summary?limit=200' });
    expect(prisma.article.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});
