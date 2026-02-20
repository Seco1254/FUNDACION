import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { FetcherParser } from './fetcher-parser.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';
import { MediaScraper } from '../domain/types.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `test/fixtures/${name}`), 'utf-8');
}

function makeDiscoveredEnvelope(url: string, mediaKey: string): EventEnvelope {
  return {
    event_name: 'ArticleDiscovered',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'ingestion' },
    payload: { url, media_key: mediaKey, discovered_at: new Date().toISOString() },
  };
}

function makeMockMediaRepo() {
  return {
    findByKey: vi.fn().mockResolvedValue({
      id: 'media-1',
      mediaKey: 'eltiempo',
      name: 'El Tiempo',
      allowlisted: true,
      createdAt: new Date(),
    }),
    findById: vi.fn(),
    findAllAllowlisted: vi.fn(),
    create: vi.fn(),
  } as any;
}

function makeMockArticleRepo() {
  return {
    findByUrl: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    create: vi.fn().mockImplementation(async (data: any) => ({
      id: 'article-1',
      ...data,
      createdAt: new Date(),
      textNorm: null,
      blockedReason: null,
    })),
    updateStatus: vi.fn().mockImplementation(async (id: string, status: string) => ({
      id,
      status,
    })),
  } as any;
}

function makeMockAuditWriter() {
  return { write: vi.fn().mockResolvedValue(undefined) };
}

describe('FetcherParser', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
  });

  it('fetches article, creates with NORMALIZED status, emits ArticleNormalized', async () => {
    const articleHtml = loadFixture('eltiempo-article.html');
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockResolvedValue(articleHtml);

    const mockScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle(html: string) {
        const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
        const snippetMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);
        const dateMatch = html.match(/<meta[^>]+property="article:published_time"[^>]+content="([^"]+)"/);
        return {
          title: titleMatch?.[1] ?? '',
          snippet: snippetMatch?.[1] ?? '',
          publishedAt: dateMatch ? new Date(dateMatch[1]) : null,
          textContent: '',
        };
      },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope(
      'https://www.eltiempo.com/politica/gobierno-anuncia-reforma-tributaria-12345',
      'eltiempo',
    );

    await fetcher.handler()(envelope);

    expect(articleRepo.create).toHaveBeenCalledOnce();
    const createCall = articleRepo.create.mock.calls[0][0];
    expect(createCall.status).toBe('NORMALIZED');
    expect(createCall.title).toBe('Gobierno anuncia reforma tributaria para 2026');
    expect(createCall.snippet.length).toBeGreaterThan(0);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticleNormalized');
    expect(published[0].payload).toHaveProperty('article_id', 'article-1');
  });

  it('emits ArticlePolicyBlocked with DUPLICATE_URL when article already exists', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    articleRepo.findByUrl.mockResolvedValue({ id: 'existing', url: 'https://example.com/dup' });
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn();
    const scraperLookup = vi.fn();

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope('https://example.com/dup', 'eltiempo');
    await fetcher.handler()(envelope);

    expect(fetchHtml).not.toHaveBeenCalled();
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'DUPLICATE_URL');
  });

  it('emits ArticlePolicyBlocked with PARSE_FAIL when fetch fails', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    const scraperLookup = vi.fn();

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope(
      'https://www.eltiempo.com/politica/test-123',
      'eltiempo',
    );
    await fetcher.handler()(envelope);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'PARSE_FAIL');
    expect(auditWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FETCH_FAIL' }),
    );
  });

  it('emits ArticlePolicyBlocked with PARSE_FAIL when parser throws', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockResolvedValue('<html>bad</html>');

    const mockScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle() { throw new Error('parse error'); },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope(
      'https://www.eltiempo.com/politica/test-456',
      'eltiempo',
    );
    await fetcher.handler()(envelope);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'PARSE_FAIL');
  });

  it('handles unique constraint violation as DUPLICATE_URL', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    articleRepo.create.mockRejectedValue(new Error('Unique constraint failed on url'));
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockResolvedValue('<html></html>');

    const mockScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle() { return { title: 'T', snippet: 'S', publishedAt: null, textContent: '' }; },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope(
      'https://www.eltiempo.com/politica/test-789',
      'eltiempo',
    );
    await fetcher.handler()(envelope);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('reason_code', 'DUPLICATE_URL');
  });
});
