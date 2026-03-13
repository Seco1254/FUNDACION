import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { healthRoutes } from './health.js';
import { tabsRoutes } from './tabs.js';
import { feedRoutes } from './feed.js';
import { eventDetailRoutes } from './event-detail.js';
import { biasRoutes } from './bias.js';
import { FeedService } from '../../modules/feed/service/feed-service.js';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { BiasLabelRepository } from '../../modules/bias/repo/bias-label-repo.js';

// Mock dependencies for unit tests (no DB)
const mockFeedServiceWithItems = {
  getFeed: async () => ({
    items: [
      {
        event_id: 'ev-feed-1',
        headline: 'Test headline',
        updated_at: '2026-02-19T12:00:00.000Z',
        published_at: '2026-02-19T11:00:00.000Z',
        cover_image_url: null,
        overview: {
          status: 'unavailable',
          what_happened: ['Evidencia en proceso de verificación.'],
          context: [],
          in_dispute: [],
          confidence_label: 'Pendiente',
        },
        sources: [
          { media_key: 'eltiempo', name: 'El Tiempo' },
          { media_key: 'elespectador', name: 'El Espectador' },
        ],
        source_count: 2,
        article_count: 3,
        evidence_level: 'medium',
        topic: { key: 'ECONOMIA', label: 'Economía' },
      },
    ],
    next_cursor: null,
    meta: { has_more: false },
  }),
} as unknown as FeedService;

const mockFeedServiceMultiEligible = {
  getFeed: async () => ({
    items: [
      {
        event_id: 'ev-multi',
        headline: 'Reforma tributaria aprobada',
        updated_at: '2026-02-19T12:00:00.000Z',
        published_at: '2026-02-19T11:00:00.000Z',
        cover_image_url: null,
        overview: {
          status: 'ready',
          what_happened: ['La reforma fue aprobada.'],
          context: ['Contexto.'],
          in_dispute: [],
          confidence_label: 'Alta',
        },
        sources: [
          { media_key: 'eltiempo', name: 'El Tiempo' },
          { media_key: 'elespectador', name: 'El Espectador' },
          { media_key: 'semana', name: 'Semana' },
        ],
        source_count: 3,
        article_count: 4,
        evidence_level: 'high',
        topic: { key: 'ECONOMIA', label: 'Economía' },
      },
    ],
    next_cursor: null,
    meta: { has_more: false },
  }),
} as unknown as FeedService;

const mockFeedServiceSingleEligible = {
  getFeed: async () => ({
    items: [
      {
        event_id: 'ev-single',
        headline: 'Alcalde anuncia plan',
        updated_at: '2026-02-19T12:00:00.000Z',
        published_at: '2026-02-19T11:00:00.000Z',
        cover_image_url: null,
        overview: {
          status: 'ready',
          what_happened: ['El alcalde anunció el plan.'],
          context: ['Plan de movilidad.'],
          in_dispute: [],
          confidence_label: 'Baja',
        },
        sources: [{ media_key: 'eltiempo', name: 'El Tiempo' }],
        source_count: 1,
        article_count: 1,
        evidence_level: 'low',
        topic: null,
      },
    ],
    next_cursor: null,
    meta: { has_more: false },
  }),
} as unknown as FeedService;

const mockFeedServicePendingOverview = {
  getFeed: async () => ({
    items: [
      {
        event_id: 'ev-pending',
        headline: 'Evento recién publicado',
        updated_at: '2026-02-19T12:00:00.000Z',
        published_at: '2026-02-19T11:00:00.000Z',
        cover_image_url: null,
        overview: {
          status: 'pending',
          what_happened: ['Evento recién publicado', 'Resumen en proceso.'],
          context: [],
          in_dispute: [],
          confidence_label: 'Pendiente',
        },
        sources: [
          { media_key: 'eltiempo', name: 'El Tiempo' },
          { media_key: 'elespectador', name: 'El Espectador' },
        ],
        source_count: 2,
        article_count: 3,
        evidence_level: 'medium',
        topic: null,
      },
    ],
    next_cursor: null,
    meta: { has_more: false },
  }),
} as unknown as FeedService;

const mockFeedService = {
  getFeed: async () => ({ items: [], next_cursor: null, meta: { has_more: false, empty_reason: 'no_events' } }),
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
  findMediaLevelByEvent: async (eventId: string, _versionId: string) => {
    if (eventId === 'with-overview') {
      return [{
        id: 'bl-1', scope: 'MEDIA_LEVEL', mediaId: 'media-1', articleId: null,
        eventId: 'with-overview', versionId: 'ver-1',
        labelPrimary: 'CRITICO', labelSecondary: null, intensity: 0.5, confidence: 0.7,
        rationaleJson: { why_short: 'Tono valorativo detectado', why_signals: ['tono valorativo'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] },
        createdAt: new Date(),
      }];
    }
    return [];
  },
  findArticleLevelByEvent: async (eventId: string, _versionId: string) => {
    if (eventId === 'with-overview') {
      return [{
        id: 'bl-2', scope: 'ARTICLE_LEVEL', mediaId: 'media-1', articleId: 'art-1',
        eventId: 'with-overview', versionId: 'ver-1',
        labelPrimary: 'EMOCIONAL', labelSecondary: 'ANTI_GOBIERNO', intensity: 0.6, confidence: 0.65,
        rationaleJson: { why_short: 'Lenguaje emocional detectado', why_signals: ['lenguaje emocional'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] },
        createdAt: new Date(),
      }];
    }
    return [];
  },
  findByMediaAndEvent: async (mediaId: string, eventId: string) => {
    if (eventId === 'with-overview' && mediaId === 'media-1') {
      return [
        { id: 'bl-1', scope: 'MEDIA_LEVEL', mediaId: 'media-1', articleId: null, eventId,
          labelPrimary: 'CRITICO', labelSecondary: null, intensity: 0.5, confidence: 0.7,
          rationaleJson: { why_short: 'Tono valorativo', why_signals: ['tono valorativo'], why_quotes: [], top_features: [], signals: [], evidence_refs: [] } },
        { id: 'bl-2', scope: 'ARTICLE_LEVEL', mediaId: 'media-1', articleId: 'art-1', eventId,
          labelPrimary: 'EMOCIONAL', labelSecondary: 'ANTI_GOBIERNO', intensity: 0.6, confidence: 0.65,
          rationaleJson: { why_short: 'Lenguaje emocional', why_signals: ['lenguaje emocional'], why_quotes: [], top_features: [], signals: [], evidence_refs: [{ type: 'article', id: 'art-1' }] } },
      ];
    }
    return [];
  },
} as unknown as BiasLabelRepository;

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
    it('responds 200', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/health' });
      expect(response.statusCode).toBe(200);
    });
  });

  describe('GET /v1/tabs', () => {
    it('returns exactly 3 tabs', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/tabs' });
      const body = response.json();
      expect(body.items).toHaveLength(3);
      expect(body.items.map((t: any) => t.key)).toEqual(['global', 'economia', 'colombia']);
    });
  });

  describe('GET /v1/feed', () => {
    it('empty feed returns meta with empty_reason', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(0);
      expect(body.meta.empty_reason).toBe('no_events');
    });

    it('feed items use new FeedCard shape', async () => {
      const richApp = Fastify();
      await richApp.register(feedRoutes(mockFeedServiceWithItems));
      await richApp.ready();

      const response = await richApp.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      const item = body.items[0];
      // New shape fields
      expect(item.overview).toBeDefined();
      expect(item.overview.status).toBe('unavailable');
      expect(item.overview.confidence_label).toBe('Pendiente');
      expect(item.sources[0]).toHaveProperty('media_key');
      expect(item.sources[0]).toHaveProperty('name');
      expect(item.source_count).toBe(2);
      expect(item.topic).toEqual({ key: 'ECONOMIA', label: 'Economía' });
      expect(item.updated_at).toBeDefined();

      // Old shape fields should NOT be present
      expect(item).not.toHaveProperty('state');
      expect(item).not.toHaveProperty('ai_overview');
      expect(item).not.toHaveProperty('overview_status');
      expect(item).not.toHaveProperty('t_last');
      expect(item).not.toHaveProperty('unique_sources_count');

      await richApp.close();
    });

    it('multi-source event has overview ready', async () => {
      const richApp = Fastify();
      await richApp.register(feedRoutes(mockFeedServiceMultiEligible));
      await richApp.ready();

      const response = await richApp.inject({ method: 'GET', url: '/v1/feed' });
      const body = response.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].overview.status).toBe('ready');
      expect(body.items[0].overview.confidence_label).toBe('Alta');

      await richApp.close();
    });

    it('pending overview event still appears in feed', async () => {
      const richApp = Fastify();
      await richApp.register(feedRoutes(mockFeedServicePendingOverview));
      await richApp.ready();

      const response = await richApp.inject({ method: 'GET', url: '/v1/feed' });
      const body = response.json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].overview.status).toBe('pending');

      await richApp.close();
    });

    it('feed does NOT include bias field', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/feed?tab=global' });
      const body = response.json();
      expect(body).not.toHaveProperty('bias');
      for (const item of body.items) {
        expect(item).not.toHaveProperty('bias');
      }
    });

    it('rejects invalid topic param', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/feed?topic=INVALID' });
      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /v1/events/:eventId', () => {
    it('returns 404 for non-existent event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/non-existent' });
      expect(response.statusCode).toBe(404);
    });

    it('responds 200 for existing event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/existing-id' });
      expect(response.statusCode).toBe(200);
    });

    it('returns overview with citations for event with overview', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview' });
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.latest_version).not.toBeNull();
      expect(body.latest_version.gate_status).toBe('PASS');
      expect(body.overview).toBeDefined();
      expect(body.overview.gate_status).toBe('PASS');

      const quePaso = body.overview.sections.find((s: any) => s.key === 'que_paso');
      expect(quePaso.bullets[0].citation_refs[0]).toHaveProperty('quote_id', 'q1');
    });

    it('includes bias/topics/heatmap in event detail', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview' });
      const body = response.json();

      expect(body.bias.media_level).toHaveLength(1);
      expect(body.bias.media_level[0].label_primary).toBe('CRITICO');
      expect(body.topics.top_topics[0].topic_key).toBe('ECONOMIA');
      expect(Array.isArray(body.topics_heatmap)).toBe(true);
    });
  });

  describe('GET /v1/events/:eventId/bias/:mediaKey', () => {
    it('returns rationale for existing media', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/with-overview/bias/eltiempo' });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.media_key).toBe('eltiempo');
      expect(body.media_level.label_primary).toBe('CRITICO');
    });

    it('returns 404 for non-existent event', async () => {
      const response = await app.inject({ method: 'GET', url: '/v1/events/nonexistent/bias/eltiempo' });
      expect(response.statusCode).toBe(404);
    });
  });
});
