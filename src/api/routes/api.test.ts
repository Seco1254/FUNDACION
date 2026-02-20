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
import { biasRoutes } from './bias.js';
import { FeedService } from '../../modules/feed/service/feed-service.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';

function loadSchema(name: string) {
  const raw = readFileSync(resolve(process.cwd(), `src/contracts/api/${name}.json`), 'utf-8');
  return JSON.parse(raw);
}

// Mock dependencies for unit tests (no DB)
const mockFeedServiceWithItems = {
  getFeed: async () => ({
    items: [
      {
        event_id: 'ev-feed-1',
        state: 'PUBLISHED',
        headline: 'Test headline',
        t_last: '2026-02-19T12:00:00.000Z',
        published_at: '2026-02-19T11:00:00.000Z',
        cover_image_url: null,
        ai_overview: null,
        overview_status: 'unavailable',
        overview_mode: 'heuristic',
        sources: [
          { source_id: 'm1', name: 'El Tiempo', domain: 'www.eltiempo.com', article_count: 2 },
          { source_id: 'm2', name: 'El Espectador', domain: 'www.elespectador.com', article_count: 1 },
        ],
        article_count: 3,
        unique_sources_count: 2,
        usable_articles_count: 1,
        total_usable_text_len: 1450,
        evidence_level: 'medium',
        why_no_overview: 'unique_sources=2, usable_articles=1, total_text=1450, fail_reasons=paywall,too_short',
      },
    ],
    next_cursor: null,
  }),
} as unknown as FeedService;

const mockFeedService = {
  getFeed: async () => ({ items: [], next_cursor: null }),
} as unknown as FeedService;

const mockEventRepo = {
  findByIdWithDetails: async (id: string) => {
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
        eventArticles: [],
      };
    }
    if (id === 'with-overview') {
      return {
        id: 'with-overview',
        state: 'PUBLISHED',
        t0: new Date('2025-06-15T12:00:00Z'),
        tLast: new Date('2025-06-15T14:00:00Z'),
        publishAt: new Date('2025-06-15T12:05:00Z'),
        publishedAt: new Date('2025-06-15T12:05:00Z'),
        closedAt: null,
        canonicalEventId: null,
        createdAt: new Date(),
        versions: [{
          id: 'ver-1',
          versionIndex: 0,
          gateStatus: 'PASS',
          headline: 'Reforma tributaria',
          packetJson: {
            overview: {
              gate_status: 'PASS',
              sections: [
                { title: 'Qué pasó', key: 'que_paso', bullets: [
                  { claim_id: 'c1', text: 'reforma tributaria aprobada', claim_type: 'FACT', status: 'SUPPORTED',
                    citation_refs: [{ quote_id: 'q1', article_id: 'art-1', media_key: 'eltiempo', url: 'https://eltiempo.com/1' }] },
                ] },
                { title: 'Contexto', key: 'contexto', bullets: [] },
                { title: 'En disputa', key: 'en_disputa', bullets: [] },
                { title: 'Qué falta por confirmar', key: 'que_falta', bullets: [] },
              ],
            },
            claims_count: 1,
            quotes_count: 1,
            topics: { top_topics: [{ topic_key: 'ECONOMIA', weight: 0.5 }], emergent: [] },
            topics_heatmap: [{ bin_index: 0, bin_start: '', bin_end: '', topics: { ECONOMIA: 1 } }],
            subevents: [],
          },
          diffJson: {},
        }],
        eventArticles: [{
          article: {
            id: 'art-1',
            mediaId: 'media-1',
            media: { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo' },
            title: 'Reforma tributaria',
            snippet: 'El gobierno aprobó la reforma',
            url: 'https://eltiempo.com/1',
            publishedAt: new Date('2025-06-15T11:00:00Z'),
            textContentLen: 1500,
            textContentSource: 'body',
            extractionFailReason: null,
            paywallDetected: false,
            usableForOverview: true,
          },
        }],
      };
    }
    return null;
  },
} as unknown as EventRepository;

const mockBiasRepo = {
  findMediaLevelByEvent: async (eventId: string, versionId: string) => {
    if (eventId === 'with-overview') {
      return [{
        id: 'bl-1',
        scope: 'MEDIA_LEVEL',
        mediaId: 'media-1',
        articleId: null,
        eventId: 'with-overview',
        versionId: 'ver-1',
        labelPrimary: 'CRITICO',
        labelSecondary: null,
        intensity: 0.5,
        confidence: 0.7,
        rationaleJson: { why_short: 'Tono valorativo detectado', why_signals: ['tono valorativo'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] },
        createdAt: new Date(),
      }];
    }
    return [];
  },
  findArticleLevelByEvent: async (eventId: string, versionId: string) => {
    if (eventId === 'with-overview') {
      return [{
        id: 'bl-2',
        scope: 'ARTICLE_LEVEL',
        mediaId: 'media-1',
        articleId: 'art-1',
        eventId: 'with-overview',
        versionId: 'ver-1',
        labelPrimary: 'EMOCIONAL',
        labelSecondary: 'ANTI_GOBIERNO',
        intensity: 0.6,
        confidence: 0.65,
        rationaleJson: { why_short: 'Lenguaje emocional detectado', why_signals: ['lenguaje emocional'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] },
        createdAt: new Date(),
      }];
    }
    return [];
  },
  findByMediaAndEvent: async (mediaId: string, eventId: string) => {
    if (eventId === 'with-overview' && mediaId === 'media-1') {
      return [
        {
          id: 'bl-1', scope: 'MEDIA_LEVEL', mediaId: 'media-1', articleId: null, eventId,
          labelPrimary: 'CRITICO', labelSecondary: null, intensity: 0.5, confidence: 0.7,
          rationaleJson: { why_short: 'Tono valorativo', why_signals: ['tono valorativo'], why_quotes: [], top_features: [], signals: [], evidence_refs: [] },
        },
        {
          id: 'bl-2', scope: 'ARTICLE_LEVEL', mediaId: 'media-1', articleId: 'art-1', eventId,
          labelPrimary: 'EMOCIONAL', labelSecondary: 'ANTI_GOBIERNO', intensity: 0.6, confidence: 0.65,
          rationaleJson: { why_short: 'Lenguaje emocional', why_signals: ['lenguaje emocional'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] },
        },
      ];
    }
    return [];
  },
} as unknown as BiasLabelRepository;

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('API contract tests', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify();
    await app.register(healthRoutes);
    await app.register(tabsRoutes);
    await app.register(feedRoutes(mockFeedService));
    await app.register(eventDetailRoutes(mockEventRepo, undefined, mockBiasRepo));
    await app.register(biasRoutes(mockEventRepo, mockBiasRepo));
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

    it('feed items include sources[], evidence_level, and why_no_overview', async () => {
      // Use a separate app with mock that returns items
      const richApp = Fastify();
      await richApp.register(feedRoutes(mockFeedServiceWithItems));
      await richApp.ready();

      const response = await richApp.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Schema validation
      const schema = loadSchema('feed');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);

      // Check new fields on the item
      const item = body.items[0];
      expect(item.sources).toHaveLength(2);
      expect(item.sources[0]).toHaveProperty('source_id');
      expect(item.sources[0]).toHaveProperty('name');
      expect(item.sources[0]).toHaveProperty('domain');
      expect(item.sources[0]).toHaveProperty('article_count');
      expect(item.article_count).toBe(3);
      expect(item.unique_sources_count).toBe(2);
      expect(item.usable_articles_count).toBe(1);
      expect(item.evidence_level).toBe('medium');
      expect(item.overview_status).toBe('unavailable');
      expect(item.why_no_overview).toContain('unique_sources=2');
      expect(item.why_no_overview).toContain('fail_reasons=');

      await richApp.close();
    });

    it('feed does NOT include bias field', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      const body = response.json();
      expect(body).not.toHaveProperty('bias');
      // Items should not have bias either
      for (const item of body.items) {
        expect(item).not.toHaveProperty('bias');
      }
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

    it('returns overview with citations (quote_id, url) for event with overview', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // Schema validation
      const schema = loadSchema('event-detail');
      const validate = ajv.compile(schema);
      const valid = validate(body);
      if (!valid) console.error(validate.errors);
      expect(valid).toBe(true);

      // latest_version present with PASS gate
      expect(body.latest_version).not.toBeNull();
      expect(body.latest_version.gate_status).toBe('PASS');

      // Overview present with sections and citations
      expect(body.overview).toBeDefined();
      expect(body.overview.gate_status).toBe('PASS');
      expect(body.overview.sections).toHaveLength(4);

      // "Qué pasó" section has bullet with citation_refs containing quote_id and url
      const quePaso = body.overview.sections.find((s: any) => s.key === 'que_paso');
      expect(quePaso).toBeDefined();
      expect(quePaso.bullets).toHaveLength(1);
      expect(quePaso.bullets[0].citation_refs).toHaveLength(1);
      expect(quePaso.bullets[0].citation_refs[0]).toHaveProperty('quote_id', 'q1');
      expect(quePaso.bullets[0].citation_refs[0]).toHaveProperty('url', 'https://eltiempo.com/1');
    });

    it('includes article diagnostics and evidence fields in event detail', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview' });
      const body = response.json();

      // Event-level evidence fields
      expect(body.article_count).toBe(1);
      expect(body.unique_sources_count).toBe(1);
      expect(body.usable_articles_count).toBe(1);
      expect(body.total_usable_text_len).toBe(1500);
      expect(body.evidence_level).toBe('low'); // 1 source, 1500 text → low
      // overview_status is 'pending' (no ai_overview in packetJson), so why_no_overview is populated
      expect(body.why_no_overview).toContain('status=pending');

      // Article-level diagnostics in media_tabs
      const tab = body.media_tabs[0];
      expect(tab.articles[0]).toHaveProperty('text_content_len', 1500);
      expect(tab.articles[0]).toHaveProperty('text_content_source', 'body');
      expect(tab.articles[0]).toHaveProperty('paywall_detected', false);
      expect(tab.articles[0]).toHaveProperty('usable_for_overview', true);
      expect(tab.articles[0]).toHaveProperty('extraction_fail_reason', null);
    });

    it('includes bias/topics/heatmap/subevents in event detail', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview' });
      const body = response.json();

      // Bias present
      expect(body.bias).toBeDefined();
      expect(body.bias.media_level).toHaveLength(1);
      expect(body.bias.media_level[0].label_primary).toBe('CRITICO');
      expect(body.bias.article_level).toHaveLength(1);
      expect(body.bias.article_level[0].label_primary).toBe('EMOCIONAL');
      expect(body.bias.article_level[0].rationale).toBeDefined();

      // Topics present
      expect(body.topics).toBeDefined();
      expect(body.topics.top_topics).toHaveLength(1);
      expect(body.topics.top_topics[0].topic_key).toBe('ECONOMIA');
      expect(body.topics.emergent).toEqual([]);

      // Heatmap present
      expect(body.topics_heatmap).toBeDefined();
      expect(Array.isArray(body.topics_heatmap)).toBe(true);
      expect(body.topics_heatmap).toHaveLength(1);

      // Subevents present (empty)
      expect(body.subevents).toBeDefined();
      expect(Array.isArray(body.subevents)).toBe(true);
    });
  });

  describe('GET /v1/events/:eventId/bias/:mediaKey', () => {
    it('returns rationale for existing media', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview/bias/eltiempo' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.media_key).toBe('eltiempo');
      expect(body.media_level).not.toBeNull();
      expect(body.media_level.label_primary).toBe('CRITICO');
      expect(body.media_level.rationale).toBeDefined();
      expect(body.media_level.rationale.why_short).toBeTruthy();

      expect(body.article_level).toHaveLength(1);
      expect(body.article_level[0].label_primary).toBe('EMOCIONAL');
      expect(body.article_level[0].rationale).toBeDefined();
    });

    it('returns 404 for non-existent event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/nonexistent/bias/eltiempo' });
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 for non-existent media key', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview/bias/unknownmedia' });
      expect(response.statusCode).toBe(404);
    });
  });
});
