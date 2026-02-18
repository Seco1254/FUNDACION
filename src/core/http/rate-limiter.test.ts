import { describe, it, expect, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import { RateLimiter } from './rate-limiter.js';

describe('RateLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows requests under the limit', async () => {
    const limiter = new RateLimiter({ windowMs: 60000, max: 5 });
    const app = Fastify();
    app.addHook('onRequest', limiter.hook());
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-ratelimit-limit']).toBe('5');
    expect(response.headers['x-ratelimit-remaining']).toBe('4');

    limiter.destroy();
    await app.close();
  });

  it('returns 429 when limit exceeded', async () => {
    const limiter = new RateLimiter({ windowMs: 60000, max: 2 });
    const app = Fastify();
    app.addHook('onRequest', limiter.hook());
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    // First 2 requests should pass
    await app.inject({ method: 'GET', url: '/test' });
    await app.inject({ method: 'GET', url: '/test' });

    // 3rd should be rate limited
    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.statusCode).toBe(429);
    const body = response.json();
    expect(body.error).toBe('Too Many Requests');
    expect(body.retry_after_seconds).toBeGreaterThan(0);
    expect(response.headers['retry-after']).toBeDefined();

    limiter.destroy();
    await app.close();
  });

  it('includes rate limit headers', async () => {
    const limiter = new RateLimiter({ windowMs: 60000, max: 10 });
    const app = Fastify();
    app.addHook('onRequest', limiter.hook());
    app.get('/test', async () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/test' });
    expect(response.headers['x-ratelimit-limit']).toBe('10');
    expect(response.headers['x-ratelimit-remaining']).toBe('9');
    expect(response.headers['x-ratelimit-reset']).toBeDefined();

    limiter.destroy();
    await app.close();
  });
});
