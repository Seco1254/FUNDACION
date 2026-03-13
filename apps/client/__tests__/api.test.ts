import { api, ApiError } from '../src/lib/api';

// Mock fetch globally
const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('API client', () => {
  describe('getFeed', () => {
    it('parses feed response correctly', async () => {
      const mockResponse = {
        items: [{
          event_id: 'e1', headline: 'Test', published_at: '2026-01-01T00:00:00Z', updated_at: null, cover_image_url: null,
          overview: { status: 'pending', what_happened: [], context: [], in_dispute: [], confidence_label: 'Pendiente' },
          topic: null, sources: [], source_count: 0, article_count: 0, evidence_level: 'low',
        }],
        next_cursor: 'abc123',
        meta: { has_more: true },
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await api.getFeed();
      expect(result.items).toHaveLength(1);
      expect(result.items[0].event_id).toBe('e1');
      expect(result.next_cursor).toBe('abc123');
    });

    it('passes cursor param correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [], next_cursor: null, meta: { has_more: false } }),
        headers: new Headers(),
      });

      await api.getFeed('my-cursor');
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('cursor=my-cursor'),
        expect.any(Object),
      );
    });

    it('handles empty feed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ items: [], next_cursor: null, meta: { has_more: false } }),
        headers: new Headers(),
      });

      const result = await api.getFeed();
      expect(result.items).toHaveLength(0);
      expect(result.next_cursor).toBeNull();
    });
  });

  describe('getEvent', () => {
    it('parses event detail response', async () => {
      const mockResponse = {
        event: { id: 'e1', state: 'PUBLISHED', t0: null, t_last: null, publish_at: null, published_at: null, closed_at: null, canonical_event_id: null },
        latest_version: null,
        media_tabs: [],
        overview: { status: 'NOT_READY' },
        bias: { media_level: [], article_level: [] },
        topics: { top_topics: [], emergent: [] },
        topics_heatmap: [],
        subevents: [],
        heatmap: {},
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await api.getEvent('e1');
      expect(result.event.id).toBe('e1');
      expect(result.media_tabs).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws ApiError on 429', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ 'retry-after': '30' }),
        json: async () => ({ error: 'Too Many Requests' }),
      });

      try {
        await api.getFeed();
        fail('Expected ApiError');
      } catch (err) {
        expect(err).toBeInstanceOf(ApiError);
        expect((err as ApiError).status).toBe(429);
      }
    });

    it('throws ApiError on 500', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        headers: new Headers(),
        json: async () => ({ error: 'Internal Server Error' }),
      });

      await expect(api.getFeed()).rejects.toThrow(ApiError);
    });

    it('throws ApiError on 404', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
        headers: new Headers(),
        json: async () => ({ error: 'Event not found' }),
      });

      await expect(api.getEvent('nonexistent')).rejects.toThrow(ApiError);
    });
  });

  describe('getBias', () => {
    it('parses bias response', async () => {
      const mockResponse = {
        media_key: 'eltiempo',
        media_level: {
          label_primary: 'CRITICO',
          label_secondary: null,
          intensity: 0.5,
          confidence: 0.7,
          rationale: { why_short: 'test', why_signals: [], why_quotes: [], top_features: [], signals: [], evidence_refs: [] },
        },
        article_level: [],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
        headers: new Headers(),
      });

      const result = await api.getBias('e1', 'eltiempo');
      expect(result.media_key).toBe('eltiempo');
      expect(result.media_level?.label_primary).toBe('CRITICO');
    });
  });

  describe('getHealth', () => {
    it('parses health response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, time: '2025-06-15T12:00:00Z' }),
        headers: new Headers(),
      });

      const result = await api.getHealth();
      expect(result.ok).toBe(true);
      expect(result.time).toBe('2025-06-15T12:00:00Z');
    });
  });
});
