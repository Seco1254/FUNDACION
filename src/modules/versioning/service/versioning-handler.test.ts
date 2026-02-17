import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VersioningHandler } from './versioning-handler.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';

function makeUpdateTriggeredEnvelope(eventId: string, trigger: string): EventEnvelope {
  return {
    event_name: 'EventUpdateTriggered',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { event_id: eventId, trigger },
  };
}

describe('VersioningHandler', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let eventRepo: any;
  let versionRepo: any;
  let mediaRepo: any;

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });

    eventRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'ev-1',
        state: 'PUBLISHED',
        t0: new Date('2025-06-15T12:00:00.000Z'),
        tLast: new Date('2025-06-15T14:00:00.000Z'),
        publishedAt: new Date('2025-06-15T12:05:00.000Z'),
      }),
      findArticlesForEvent: vi.fn().mockResolvedValue([
        {
          id: 'art-1',
          mediaId: 'media-1',
          title: 'Test Article',
          snippet: 'Test snippet',
          url: 'https://example.com/article',
          publishedAt: new Date('2025-06-15T12:00:00.000Z'),
        },
      ]),
    };

    versionRepo = {
      findLatestByEventId: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async (data: any) => ({
        id: 'ver-1',
        ...data,
        createdAt: new Date(),
      })),
    };

    mediaRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'media-1', mediaKey: 'eltiempo' }),
    };
  });

  it('creates first version (index 0) on EventUpdateTriggered', async () => {
    const handler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    await handler.handler()(makeUpdateTriggeredEnvelope('ev-1', 'NEW_ARTICLE'));

    expect(versionRepo.create).toHaveBeenCalledOnce();
    const createCall = versionRepo.create.mock.calls[0][0];
    expect(createCall.eventId).toBe('ev-1');
    expect(createCall.versionIndex).toBe(0);
    expect(createCall.headline).toBe('Test Article');

    const packet = createCall.packetJson;
    expect(packet.event_id).toBe('ev-1');
    expect(packet.version_index).toBe(0);
    expect(packet.articles).toHaveLength(1);
    expect(packet.articles[0].media_key).toBe('eltiempo');

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('EventVersionCommitted');
    expect(published[0].payload).toHaveProperty('version_index', 0);
  });

  it('increments version index from previous version', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue({
      versionIndex: 2,
      packetJson: { articles: [{ article_id: 'art-1' }] },
    });

    const handler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    await handler.handler()(makeUpdateTriggeredEnvelope('ev-1', 'REFRESH_JOB'));

    const createCall = versionRepo.create.mock.calls[0][0];
    expect(createCall.versionIndex).toBe(3);
  });

  it('computes diff_json with added articles', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue({
      versionIndex: 0,
      packetJson: { articles: [] },
    });

    const handler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    await handler.handler()(makeUpdateTriggeredEnvelope('ev-1', 'NEW_ARTICLE'));

    const createCall = versionRepo.create.mock.calls[0][0];
    expect(createCall.diffJson.added_articles).toContain('art-1');
    expect(createCall.diffJson.reason).toBe('NEW_ARTICLE');
  });

  it('does nothing when event not found', async () => {
    eventRepo.findById.mockResolvedValue(null);

    const handler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    await handler.handler()(makeUpdateTriggeredEnvelope('missing-ev', 'NEW_ARTICLE'));

    expect(versionRepo.create).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('handles event with no articles gracefully', async () => {
    eventRepo.findArticlesForEvent.mockResolvedValue([]);

    const handler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);
    await handler.handler()(makeUpdateTriggeredEnvelope('ev-1', 'NEW_ARTICLE'));

    const createCall = versionRepo.create.mock.calls[0][0];
    expect(createCall.packetJson.articles).toEqual([]);
    expect(createCall.headline).toContain('2025');
  });
});
