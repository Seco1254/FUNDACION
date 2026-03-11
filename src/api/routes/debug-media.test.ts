import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { debugMediaRoutes } from './debug-media.js';

function makeMockMediaRepo(allMedia: Array<{ id: string; mediaKey: string; name: string; allowlisted: boolean; createdAt: Date }>) {
  return {
    findAll: async () => allMedia,
    findAllAllowlisted: async () => allMedia.filter((m) => m.allowlisted),
    findByKey: async () => null,
    findById: async () => null,
    create: async () => null,
  } as any;
}

describe('GET /v1/debug/media/status', () => {
  it('returns eligible and excluded media', async () => {
    const repo = makeMockMediaRepo([
      { id: '1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date() },
      { id: '2', mediaKey: 'elespectador', name: 'El Espectador', allowlisted: true, createdAt: new Date() },
      { id: '3', mediaKey: 'blocked_media', name: 'Blocked', allowlisted: false, createdAt: new Date() },
    ]);

    const app = Fastify();
    app.register(debugMediaRoutes(repo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/media/status' });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.media_total).toBe(3);
    expect(body.eligible_total).toBe(2);
    expect(body.eligible_media_keys).toEqual(['eltiempo', 'elespectador']);
    expect(body.excluded).toHaveLength(1);
    expect(body.excluded[0].media_key).toBe('blocked_media');
    expect(body.excluded[0].reason).toBe('allowlisted=false');
    expect(body.fix).toBeNull();
  });

  it('returns fix message when no eligible media', async () => {
    const repo = makeMockMediaRepo([]);

    const app = Fastify();
    app.register(debugMediaRoutes(repo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/media/status' });
    const body = res.json();

    expect(body.media_total).toBe(0);
    expect(body.eligible_total).toBe(0);
    expect(body.fix).toBe('Run: npm run db:seed:minimal');
  });

  it('reports missing DB rows for known scrapers', async () => {
    // Only 2 of 8 known scrapers have DB rows
    const repo = makeMockMediaRepo([
      { id: '1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date() },
      { id: '2', mediaKey: 'elespectador', name: 'El Espectador', allowlisted: true, createdAt: new Date() },
    ]);

    const app = Fastify();
    app.register(debugMediaRoutes(repo));
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/v1/debug/media/status' });
    const body = res.json();

    expect(body.missing_db_rows).toContain('razon_publica');
    expect(body.missing_db_rows).toContain('flip');
    expect(body.missing_db_rows).not.toContain('eltiempo');
    expect(body.missing_db_rows).not.toContain('elespectador');
  });
});
