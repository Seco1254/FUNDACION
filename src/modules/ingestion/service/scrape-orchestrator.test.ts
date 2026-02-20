import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ScrapeOrchestrator, ScrapeProgress } from './scrape-orchestrator.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { MediaScraper } from '../domain/types.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `test/fixtures/${name}`), 'utf-8');
}

function makeMockMediaRepo(media: Array<{ id: string; mediaKey: string; allowlisted: boolean }>) {
  return {
    findAllAllowlisted: vi.fn().mockResolvedValue(
      media.filter((m) => m.allowlisted).map((m) => ({
        id: m.id,
        mediaKey: m.mediaKey,
        name: m.mediaKey,
        allowlisted: m.allowlisted,
        createdAt: new Date(),
      })),
    ),
    findByKey: vi.fn(),
    findById: vi.fn(),
    create: vi.fn(),
  } as any;
}

function makeMockArticleRepo() {
  return {
    findByUrl: vi.fn().mockResolvedValue(null),
    findById: vi.fn(),
    create: vi.fn(),
    updateStatus: vi.fn(),
  } as any;
}

function makeMockAuditWriter() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ScrapeOrchestrator', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    const origPublish = eventBus.publish.bind(eventBus);
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
  });

  it('discovers 3 URLs from fixture list page and emits 3 ArticleDiscovered', async () => {
    const listHtml = loadFixture('eltiempo-list.html');
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls(html: string) {
        const urls: string[] = [];
        const regex = /href=["'](https:\/\/www\.eltiempo\.com\/[\w-]+\/[\w-]+-\d+)["']/gi;
        let match;
        while ((match = regex.exec(html)) !== null) urls.push(match[1]);
        return [...new Set(urls)];
      },
      parseArticle() {
        return { title: '', snippet: '', publishedAt: null, textContent: '' };
      },
    };

    const fetchHtml = vi.fn().mockResolvedValue(listHtml);
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();
    // Allow fire-and-forget microtasks to settle
    await Promise.resolve();

    expect(result.discovered).toBe(3);
    expect(result.skipped).toBe(0);
    expect(published).toHaveLength(3);

    for (const env of published) {
      expect(env.event_name).toBe('ArticleDiscovered');
      expect(env.payload).toHaveProperty('url');
      expect(env.payload).toHaveProperty('media_key', 'eltiempo');
      expect(env.payload).toHaveProperty('discovered_at');
    }
  });

  it('deduplicates URLs within the same run', async () => {
    const html = `
      <a href="https://www.eltiempo.com/politica/test-article-123">A</a>
      <a href="https://www.eltiempo.com/politica/test-article-123">B</a>
      <a href="https://www.eltiempo.com/economia/otro-articulo-456">C</a>
    `;
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls(h: string) {
        const urls: string[] = [];
        const regex = /href=["'](https:\/\/www\.eltiempo\.com\/[\w-]+\/[\w-]+-\d+)["']/gi;
        let match;
        while ((match = regex.exec(h)) !== null) urls.push(match[1]);
        return urls; // intentionally NOT deduped to test orchestrator dedupe
      },
      parseArticle() {
        return { title: '', snippet: '', publishedAt: null, textContent: '' };
      },
    };

    const fetchHtml = vi.fn().mockResolvedValue(html);
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.discovered).toBe(2);
    expect(result.skipped).toBe(1);
  });

  it('skips URLs that already exist in DB', async () => {
    const html = `<a href="https://www.eltiempo.com/politica/existing-123">A</a>`;
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    articleRepo.findByUrl.mockResolvedValue({ id: 'existing', url: 'https://www.eltiempo.com/politica/existing-123' });

    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls() {
        return ['https://www.eltiempo.com/politica/existing-123'];
      },
      parseArticle() {
        return { title: '', snippet: '', publishedAt: null, textContent: '' };
      },
    };

    const fetchHtml = vi.fn().mockResolvedValue(html);
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.discovered).toBe(0);
    expect(result.skipped).toBe(1);
    expect(published).toHaveLength(0);
  });

  it('writes audit log when list page fetch fails', async () => {
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls() { return []; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };

    const fetchHtml = vi.fn().mockRejectedValue(new Error('network error'));
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.discovered).toBe(0);
    expect(auditWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCRAPE_FAIL',
        entity_type: 'ARTICLE',
      }),
    );
  });

  it('skips media with stub scraper (no list page URLs)', async () => {
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-3', mediaKey: 'MEDIA_3', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const stubScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };

    const fetchHtml = vi.fn();
    const scraperLookup = vi.fn().mockReturnValue(stubScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.discovered).toBe(0);
    expect(fetchHtml).not.toHaveBeenCalled();
  });

  it('returns empty result and does not fetch when no eligible media', async () => {
    const mediaRepo = makeMockMediaRepo([]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn();
    const scraperLookup = vi.fn();

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.discovered).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.media_results).toHaveLength(0);
    expect(Object.keys(result.summary)).toHaveLength(0);
    expect(fetchHtml).not.toHaveBeenCalled();
    expect(scraperLookup).not.toHaveBeenCalled();
  });

  it('returns media_results with per-media timing and stats', async () => {
    const html = `<a href="https://www.eltiempo.com/politica/test-article-123">A</a>`;
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls() {
        return ['https://www.eltiempo.com/politica/test-article-123'];
      },
      parseArticle() {
        return { title: '', snippet: '', publishedAt: null, textContent: '' };
      },
    };

    const fetchHtml = vi.fn().mockResolvedValue(html);
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();

    expect(result.media_results).toHaveLength(1);
    expect(result.media_results[0]).toEqual(expect.objectContaining({
      media_key: 'eltiempo',
      ok: true,
      discovered: 1,
      skipped: 0,
      fetch_fail: 0,
    }));
    expect(result.media_results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });

  // ── Observability ──────────────────────────────────────────────────────

  it('calls onProgress with stage events including media_key and url', async () => {
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls() { return []; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };

    const fetchHtml = vi.fn().mockResolvedValue('<html></html>');
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);
    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const progress: ScrapeProgress[] = [];
    await orchestrator.run((p) => progress.push(p));

    const stages = progress.map((p) => p.stage);
    expect(stages).toContain('orchestrator_start');
    expect(stages).toContain('media_list_end');
    expect(stages).toContain('media_run_start');
    expect(stages).toContain('fetch_start');
    expect(stages).toContain('parse_start');
    expect(stages).toContain('parse_end');
    expect(stages).toContain('media_run_end');
    expect(stages).toContain('orchestrator_end');

    const fetchStartEvent = progress.find((p) => p.stage === 'fetch_start');
    expect(fetchStartEvent?.url).toBe('https://www.eltiempo.com/');
    expect(fetchStartEvent?.media_key).toBe('eltiempo');
  });

  // ── Per-media timeout isolation ──────────────────────────────────────

  it('per-media timeout: slow fetch records fetch_fail; fast media still completes', async () => {
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-A', mediaKey: 'slow-media', allowlisted: true },
      { id: 'media-B', mediaKey: 'fast-media', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const slowScraper: MediaScraper = {
      listPageUrls: ['https://slow.example.com/'],
      extractUrls() { return []; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };
    const fastScraper: MediaScraper = {
      listPageUrls: ['https://fast.example.com/'],
      extractUrls() { return ['https://fast.example.com/article-1']; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };

    const fetchHtml = vi.fn().mockImplementation((url: string) => {
      if (url.includes('slow')) {
        return new Promise((_resolve) => setTimeout(_resolve, 500));
      }
      return Promise.resolve('<html></html>');
    });
    const scraperLookup = vi.fn().mockImplementation((key: string) =>
      key === 'slow-media' ? slowScraper : fastScraper,
    );

    const savedEnv = process.env.SCRAPE_MEDIA_TIMEOUT_MS;
    process.env.SCRAPE_MEDIA_TIMEOUT_MS = '100';

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const start = Date.now();
    const result = await orchestrator.run();
    const elapsed = Date.now() - start;

    process.env.SCRAPE_MEDIA_TIMEOUT_MS = savedEnv;
    await Promise.resolve();

    expect(elapsed).toBeLessThan(800);
    expect(result.summary['slow-media']).toBeDefined();
    expect(result.summary['slow-media'].fetch_fail).toBeGreaterThan(0);
    expect(result.summary['fast-media'].discovered).toBe(1);
    expect(result.discovered).toBe(1);
  });

  // ── Fire-and-forget safety ────────────────────────────────────────────

  it('pipeline publish error does not propagate to orchestrator', async () => {
    const mediaRepo = makeMockMediaRepo([
      { id: 'media-1', mediaKey: 'eltiempo', allowlisted: true },
    ]);
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://www.eltiempo.com/'],
      extractUrls() { return ['https://www.eltiempo.com/article-1']; },
      parseArticle() { return { title: '', snippet: '', publishedAt: null, textContent: '' }; },
    };

    vi.spyOn(eventBus, 'publish').mockRejectedValue(new Error('pipeline exploded'));

    const fetchHtml = vi.fn().mockResolvedValue('<html></html>');
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);
    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const result = await orchestrator.run();
    await Promise.resolve();

    expect(result.discovered).toBe(1);
    expect(result.summary['eltiempo'].discovered).toBe(1);
  });
});
