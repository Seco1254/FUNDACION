import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import feedSchema from '../../contracts/api/feed.json';
import feedFixture from '../fixtures/feed-card.fixture.json';
import { buildFeedItem } from '../../modules/feed/service/feed-service.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(feedSchema);

describe('Feed contract', () => {
  it('fixture validates against JSON schema', () => {
    const valid = validate(feedFixture);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('buildFeedItem output validates against FeedCard schema', () => {
    const row = {
      id: 'evt-contract-1',
      state: 'PUBLISHED',
      tLast: new Date('2026-02-20T10:00:00Z'),
      publishedAt: new Date('2026-02-20T09:00:00Z'),
      createdAt: new Date('2026-02-20T08:00:00Z'),
      versions: [{
        id: 'ver-1',
        headline: 'Test contract headline',
        packetJson: {
          ai_overview: {
            what_happened: ['La reforma tributaria fue aprobada en segundo debate del Congreso.'],
            context: ['El gobierno espera que la reforma genere nuevos ingresos fiscales.'],
            in_dispute: [],
            confidence_label: 'Alta',
          },
        },
      }],
      topicAssignments: [{ topicKey: 'ECONOMIA', weight: 0.9 }],
      eventArticles: [{
        article: {
          id: 'art-1',
          url: 'https://www.eltiempo.com/test',
          media: { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo' },
          textContentLen: 1500,
          textContentSource: 'body',
          extractionFailReason: null,
          paywallDetected: false,
          usableForOverview: true,
        },
      }],
    };

    const { item, eligible } = buildFeedItem(row);
    expect(eligible).toBe(true);

    const response = { items: [item], next_cursor: null, meta: { has_more: false } };
    const valid = validate(response);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('FeedCard has no internal fields', () => {
    const row = {
      id: 'evt-internal',
      state: 'PUBLISHED',
      tLast: new Date(),
      publishedAt: new Date(),
      createdAt: new Date(),
      versions: [{ id: 'v1', headline: 'H', packetJson: {} }],
      topicAssignments: [],
      eventArticles: [{
        article: {
          id: 'a1', url: 'https://x.com/a', usableForOverview: true,
          media: { id: 'm1', mediaKey: 'x', name: 'X' },
          textContentLen: 500, textContentSource: 'body',
          extractionFailReason: null, paywallDetected: false,
        },
      }],
    };

    const { item } = buildFeedItem(row);
    const raw = item as any;

    // These internal fields must NOT appear in the product contract
    expect(raw.state).toBeUndefined();
    expect(raw.t_last).toBeUndefined();
    expect(raw.ai_overview).toBeUndefined();
    expect(raw.overview_status).toBeUndefined();
    expect(raw.unique_sources_count).toBeUndefined();
    expect(raw.usable_articles_count).toBeUndefined();
    expect(raw.total_usable_text_len).toBeUndefined();
    expect(raw.key_facts_count).toBeUndefined();
    expect(raw.overview_mode).toBeUndefined();
    expect(raw.why_no_overview).toBeUndefined();
  });

  it('overview.status is one of ready | pending | unavailable', () => {
    const row = {
      id: 'evt-status',
      state: 'PUBLISHED',
      tLast: new Date(),
      publishedAt: new Date(),
      createdAt: new Date(),
      versions: [{ id: 'v1', headline: 'H', packetJson: {} }],
      topicAssignments: [],
      eventArticles: [{
        article: {
          id: 'a1', url: 'https://x.com/a', usableForOverview: true,
          media: { id: 'm1', mediaKey: 'x', name: 'X' },
          textContentLen: 500, textContentSource: 'body',
          extractionFailReason: null, paywallDetected: false,
        },
      }],
    };

    const { item } = buildFeedItem(row);
    expect(['ready', 'pending', 'unavailable']).toContain(item.overview.status);
  });

  it('confidence_label is from closed set', () => {
    const validLabels = ['Alta', 'Media', 'Baja', 'Pendiente', 'No concluyente'];
    const row = {
      id: 'evt-conf',
      state: 'PUBLISHED',
      tLast: new Date(),
      publishedAt: new Date(),
      createdAt: new Date(),
      versions: [{
        id: 'v1', headline: 'H',
        packetJson: { ai_overview: { what_happened: ['La reforma fue aprobada en debate final por el Congreso.'], context: [], in_dispute: [], confidence_label: 'INVALID' } },
      }],
      topicAssignments: [],
      eventArticles: [{
        article: {
          id: 'a1', url: 'https://x.com/a', usableForOverview: true,
          media: { id: 'm1', mediaKey: 'x', name: 'X' },
          textContentLen: 500, textContentSource: 'body',
          extractionFailReason: null, paywallDetected: false,
        },
      }],
    };

    const { item } = buildFeedItem(row);
    expect(validLabels).toContain(item.overview.confidence_label);
    // Invalid label should default to 'No concluyente'
    expect(item.overview.confidence_label).toBe('No concluyente');
  });

  it('sources use media_key not source_id', () => {
    const row = {
      id: 'evt-src',
      state: 'PUBLISHED',
      tLast: new Date(),
      publishedAt: new Date(),
      createdAt: new Date(),
      versions: [{ id: 'v1', headline: 'H', packetJson: {} }],
      topicAssignments: [],
      eventArticles: [{
        article: {
          id: 'a1', url: 'https://x.com/a', usableForOverview: true,
          media: { id: 'm1', mediaKey: 'eltiempo', name: 'El Tiempo' },
          textContentLen: 500, textContentSource: 'body',
          extractionFailReason: null, paywallDetected: false,
        },
      }],
    };

    const { item } = buildFeedItem(row);
    expect(item.sources[0].media_key).toBe('eltiempo');
    expect(item.sources[0].name).toBe('El Tiempo');
    expect((item.sources[0] as any).source_id).toBeUndefined();
    expect((item.sources[0] as any).domain).toBeUndefined();
  });
});
