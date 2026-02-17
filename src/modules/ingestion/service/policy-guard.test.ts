import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PolicyGuard } from './policy-guard.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';

function makeNormalizedEnvelope(articleId: string): EventEnvelope {
  return {
    event_name: 'ArticleNormalized',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'ingestion' },
    payload: { article_id: articleId },
  };
}

function makeMockMediaRepo(overrides: Partial<{ allowlisted: boolean }> = {}) {
  return {
    findById: vi.fn().mockResolvedValue({
      id: 'media-1',
      mediaKey: 'eltiempo',
      name: 'El Tiempo',
      allowlisted: overrides.allowlisted ?? true,
      createdAt: new Date(),
    }),
    findByKey: vi.fn(),
    findAllAllowlisted: vi.fn(),
    create: vi.fn(),
  } as any;
}

function makeMockArticleRepo(article: Record<string, unknown>) {
  return {
    findById: vi.fn().mockResolvedValue({
      id: 'article-1',
      mediaId: 'media-1',
      url: 'https://www.eltiempo.com/politica/test-123',
      status: 'NORMALIZED',
      blockedReason: null,
      createdAt: new Date(),
      textNorm: null,
      publishedAt: null,
      ...article,
    }),
    findByUrl: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function makeMockAuditWriter() {
  return { write: vi.fn().mockResolvedValue(undefined) };
}

describe('PolicyGuard', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
  });

  it('emits ArticlePolicyOk for valid Spanish article with sufficient snippet', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Gobierno anuncia reforma',
      snippet:
        'El presidente de Colombia anunció una nueva reforma tributaria que busca aumentar los ingresos del Estado en un 15 por ciento para financiar programas sociales.',
    });
    const mediaRepo = makeMockMediaRepo();
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(articleRepo.updateStatus).toHaveBeenCalledWith('article-1', 'POLICY_OK');
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyOk');
    expect(published[0].payload).toHaveProperty('article_id', 'article-1');
  });

  it('blocks with NO_EXTRACT when snippet is too short', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Test',
      snippet: 'Corto',
    });
    const mediaRepo = makeMockMediaRepo();
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(articleRepo.updateStatus).toHaveBeenCalledWith('article-1', 'POLICY_BLOCKED', 'NO_EXTRACT');
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'NO_EXTRACT');
  });

  it('blocks with NO_EXTRACT when snippet is empty', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Test',
      snippet: '',
    });
    const mediaRepo = makeMockMediaRepo();
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(published[0].payload).toHaveProperty('reason_code', 'NO_EXTRACT');
  });

  it('blocks with NOT_SPANISH when text is English', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Government announces reform',
      snippet:
        'The president of the United States announced a new tax reform that would increase government revenue by 15 percent to fund social programs in the country.',
    });
    const mediaRepo = makeMockMediaRepo();
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(articleRepo.updateStatus).toHaveBeenCalledWith('article-1', 'POLICY_BLOCKED', 'NOT_SPANISH');
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'NOT_SPANISH');
  });

  it('blocks with NOT_ALLOWLISTED when media is not allowlisted', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Test',
      snippet:
        'El presidente de Colombia anunció una nueva reforma tributaria que busca aumentar los ingresos del Estado en un 15 por ciento para financiar programas sociales.',
    });
    const mediaRepo = makeMockMediaRepo({ allowlisted: false });
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(articleRepo.updateStatus).toHaveBeenCalledWith('article-1', 'POLICY_BLOCKED', 'NOT_ALLOWLISTED');
    expect(published[0].payload).toHaveProperty('reason_code', 'NOT_ALLOWLISTED');
  });

  it('blocks with NOT_ALLOWLISTED when media is not found', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Test',
      snippet:
        'El presidente de Colombia anunció una nueva reforma tributaria que busca aumentar los ingresos del Estado.',
    });
    const mediaRepo = makeMockMediaRepo();
    mediaRepo.findById.mockResolvedValue(null);
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(published[0].payload).toHaveProperty('reason_code', 'NOT_ALLOWLISTED');
  });

  it('writes audit log entry on policy block', async () => {
    const articleRepo = makeMockArticleRepo({
      title: 'Test',
      snippet: 'Too short',
    });
    const mediaRepo = makeMockMediaRepo();
    const auditWriter = makeMockAuditWriter();

    const guard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);
    await guard.handler()(makeNormalizedEnvelope('article-1'));

    expect(auditWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'ARTICLE',
        entity_id: 'article-1',
        action: 'POLICY_FAIL',
        data: expect.objectContaining({ reason_code: 'NO_EXTRACT' }),
      }),
    );
  });
});
