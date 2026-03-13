import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingService } from './embedding-service.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';

function makeEnvelope(articleId: string): EventEnvelope {
  return {
    event_name: 'ArticlePolicyOk',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { article_id: articleId },
  };
}

describe('EmbeddingService', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let articleRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
    articleRepo = {
      findById: vi.fn(),
      updateEmbedding: vi.fn().mockResolvedValue({}),
    };
    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
  });

  it('computes embedding for article and emits ArticleEmbedded', async () => {
    articleRepo.findById.mockResolvedValue({
      id: 'art-1',
      title: 'Reforma tributaria en Colombia',
      snippet: 'El gobierno colombiano anuncia nueva reforma',
      embeddingHash: null,
    });

    const service = new EmbeddingService(articleRepo, eventBus, auditWriter);
    await service.handler()(makeEnvelope('art-1'));

    expect(articleRepo.updateEmbedding).toHaveBeenCalledOnce();
    const updateCall = articleRepo.updateEmbedding.mock.calls[0];
    expect(updateCall[0]).toBe('art-1');
    expect(updateCall[1].embeddingModel).toBe('hash256-v0.2');
    expect(updateCall[1].embeddingVec).toHaveLength(256);
    expect(updateCall[1].embeddingHash).toHaveLength(64);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticleEmbedded');
    expect(published[0].payload).toHaveProperty('article_id', 'art-1');
  });

  it('skips re-computing when embeddingHash matches (idempotent)', async () => {
    const { computeEmbeddingHash, textForEmbedding } = await import('./hash-vector.js');
    const text = textForEmbedding('Title', 'Snippet');
    const hash = computeEmbeddingHash(text);

    articleRepo.findById.mockResolvedValue({
      id: 'art-2',
      title: 'Title',
      snippet: 'Snippet',
      embeddingHash: hash,
    });

    const service = new EmbeddingService(articleRepo, eventBus, auditWriter);
    await service.handler()(makeEnvelope('art-2'));

    expect(articleRepo.updateEmbedding).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticleEmbedded');
  });

  it('does nothing when article not found', async () => {
    articleRepo.findById.mockResolvedValue(null);

    const service = new EmbeddingService(articleRepo, eventBus, auditWriter);
    await service.handler()(makeEnvelope('missing'));

    expect(articleRepo.updateEmbedding).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });
});
