import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { healthRoutes } from './health.js';
import { tabsRoutes } from './tabs.js';
import { feedRoutes } from './feed.js';
import { eventDetailRoutes } from './event-detail.js';
import { FeedService } from '../../modules/feed/service/feed-service.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';

function loadSchema(name: string) {
  const raw = readFileSync(resolve(process.cwd(), `src/contracts/api/${name}.json`), 'utf-8');
  return JSON.parse(raw);
}

// Mock dependencies for unit tests (no DB)
const mockFeedService = {
  getFeed: async () => ({ items: [], next_cursor: null }),
} as unknown as FeedService;

const mockEventRepo = {
  findByIdWithLatestVersion: async (id: string) => {
    if (id === 'existing-id') {
      return {
        id: 'existing-id',
        state: 'DETECTED',
        t0: null,
        tLast: null,
        publishAt: null,
        publishedAt: null,
        closedAt: null,
        canonicalEventId: null,
        createdAt: new Date(),
        versions: [],
      };
    }
    return null;
  },
} as unknown as EventRepository;

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('API contract tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(healthRoutes);
    await app.register(tabsRoutes);
    await app.register(feedRoutes(mockFeedService));
    await app.register(eventDetailRoutes(mockEventRepo));
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /v1/health', () => {
    it('responds with valid schema', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const schema = loadSchema('health');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);
    });
  });

  describe('GET /v1/tabs', () => {
    it('responds with valid schema', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/tabs' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const schema = loadSchema('tabs');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);
    });

    it('returns exactly 3 tabs', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/tabs' });
      const body = response.json();
      expect(body.items).toHaveLength(3);
      expect(body.items.map((t: any) => t.key)).toEqual(['global', 'economia', 'colombia']);
    });
  });

  describe('GET /v1/feed', () => {
    it('responds with valid schema (empty feed)', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const schema = loadSchema('feed');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);
    });
  });

  describe('GET /v1/events/:eventId', () => {
    it('returns 404 for non-existent event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/non-existent' });
      expect(response.statusCode).toBe(404);
    });

    it('responds with valid schema for existing event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/existing-id' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const schema = loadSchema('event-detail');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);
    });

    it('returns null latest_version when no versions exist', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/existing-id' });
      const body = response.json();
      expect(body.latest_version).toBeNull();
    });
  });
});
