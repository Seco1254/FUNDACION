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

  it('populates article diagnostic fields (textContentLen, source, paywall, usable)', async () => {
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
        // Return realistic textContent (>= 800 chars so usableForOverview = true)
        return {
          title: titleMatch?.[1] ?? 'Test Title',
          snippet: snippetMatch?.[1] ?? 'Test snippet',
          publishedAt: null,
          textContent: 'A'.repeat(1000),
        };
      },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope(
      'https://www.eltiempo.com/politica/diagnostics-test',
      'eltiempo',
    );
    await fetcher.handler()(envelope);

    expect(articleRepo.create).toHaveBeenCalledOnce();
    const data = articleRepo.create.mock.calls[0][0];

    expect(data.textContentLen).toBe(1000);
    expect(data.textContentSource).toBe('body');
    expect(data.paywallDetected).toBe(false);
    expect(data.usableForOverview).toBe(true);
    expect(data.extractionFailReason).toBeNull();
  });

  it('sets extractionFailReason=empty when textContent is empty', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockResolvedValue('<html><body><p>short</p></body></html>');

    const mockScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle() {
        return { title: 'Test', snippet: 'A snippet', publishedAt: null, textContent: '' };
      },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/empty-test', 'eltiempo');
    await fetcher.handler()(envelope);

    const data = articleRepo.create.mock.calls[0][0];
    expect(data.textContentLen).toBe(0);
    expect(data.extractionFailReason).toBe('empty');
    expect(data.usableForOverview).toBe(false);
  });

  it('detects paywall and sets paywallDetected + extractionFailReason', async () => {
    const paywallHtml = '<html><body><div class="paywall">Contenido exclusivo para suscriptores</div><article><p>' + 'A'.repeat(100) + '</p></article></body></html>';
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockResolvedValue(paywallHtml);

    const mockScraper: MediaScraper = {
      listPageUrls: [],
      extractUrls() { return []; },
      parseArticle() {
        return { title: 'Paywall Article', snippet: 'Locked', publishedAt: null, textContent: 'A'.repeat(1000) };
      },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/paywall-test', 'eltiempo');
    await fetcher.handler()(envelope);

    const data = articleRepo.create.mock.calls[0][0];
    expect(data.paywallDetected).toBe(true);
    expect(data.extractionFailReason).toBe('paywall');
    expect(data.usableForOverview).toBe(false);
  });

  describe('text acquisition ladder', () => {
    it('prefers body text when scraper provides sufficient content', async () => {
      const html = `<html><head>
        <meta property="og:description" content="This meta description should not be used">
        <link rel="amphtml" href="https://amp.example.com/test">
      </head><body><article><p>Some short content</p></article></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(html);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Body Preferred', snippet: 'Snippet', publishedAt: null, textContent: 'C'.repeat(1000) };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/body-preferred', 'eltiempo');
      await fetcher.handler()(envelope);

      // AMP should NOT be fetched since body text is sufficient
      expect(fetchHtml).toHaveBeenCalledTimes(1);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('body');
      expect(data.textContentLen).toBe(1000);
      expect(data.usableForOverview).toBe(true);
      expect(data.extractionFailReason).toBeNull();
    });

    it('falls back to AMP when body text is too short', async () => {
      const mainHtml = `<html><head>
        <link rel="amphtml" href="https://amp.eltiempo.com/article-123">
      </head><body><article><p>Short body</p></article></body></html>`;

      const ampParagraphs = Array.from({ length: 10 }, (_, i) =>
        `<p>Paragraph ${i}: ${'B'.repeat(100)}</p>`
      ).join('');
      const ampHtml = `<html><body><article>${ampParagraphs}</article></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn()
        .mockResolvedValueOnce(mainHtml)
        .mockResolvedValueOnce(ampHtml);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'AMP Fallback', snippet: 'Snippet', publishedAt: null, textContent: 'Short' };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/amp-fallback', 'eltiempo');
      await fetcher.handler()(envelope);

      expect(fetchHtml).toHaveBeenCalledTimes(2);
      expect(fetchHtml).toHaveBeenLastCalledWith('https://amp.eltiempo.com/article-123');

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('amp');
      expect(data.textContentLen).toBeGreaterThan(800);
      expect(data.usableForOverview).toBe(true);
    });

    it('falls back to meta description when body and AMP are unavailable', async () => {
      const metaDesc = 'X'.repeat(250);
      const html = `<html><head>
        <meta property="og:description" content="${metaDesc}">
      </head><body></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(html);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Meta Fallback', snippet: 'Snippet', publishedAt: null, textContent: '' };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/meta-fallback', 'eltiempo');
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('meta');
      expect(data.textContentLen).toBe(250);
      expect(data.usableForOverview).toBe(true);
      expect(data.extractionFailReason).toBeNull();
    });

    it('sets textContentSource=none and extractionFailReason=empty when all steps fail', async () => {
      const html = '<html><body></body></html>';

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(html);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Empty Test', snippet: '', publishedAt: null, textContent: '' };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/empty-ladder', 'eltiempo');
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('none');
      expect(data.textContentLen).toBe(0);
      expect(data.usableForOverview).toBe(false);
      expect(data.extractionFailReason).toBe('empty');
    });

    it('marks meta text below MIN_LEN_META as too_short and not usable', async () => {
      const shortMeta = 'Y'.repeat(100);
      const html = `<html><head>
        <meta property="og:description" content="${shortMeta}">
      </head><body></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(html);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Short Meta', snippet: 'Snippet', publishedAt: null, textContent: '' };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/short-meta', 'eltiempo');
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('meta');
      expect(data.textContentLen).toBe(100);
      expect(data.usableForOverview).toBe(false);
      expect(data.extractionFailReason).toBe('too_short');
    });

    it('skips AMP gracefully when AMP fetch fails, falls back to meta', async () => {
      const html = `<html><head>
        <link rel="amphtml" href="https://amp.eltiempo.com/broken">
        <meta property="og:description" content="${'Z'.repeat(250)}">
      </head><body></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn()
        .mockResolvedValueOnce(html)
        .mockRejectedValueOnce(new Error('AMP fetch failed'));

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'AMP Fail', snippet: 'Snippet', publishedAt: null, textContent: '' };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/amp-fail', 'eltiempo');
      await fetcher.handler()(envelope);

      expect(fetchHtml).toHaveBeenCalledTimes(2);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('meta');
      expect(data.textContentLen).toBe(250);
      expect(data.usableForOverview).toBe(true);
    });

    it('text_content_source and text_content_len are always set regardless of outcome', async () => {
      const testCases = [
        { textContent: 'A'.repeat(1000), expectedSource: 'body', expectedLen: 1000 },
        { textContent: '', expectedSource: 'none', expectedLen: 0 },
      ];

      for (const tc of testCases) {
        const mediaRepo = makeMockMediaRepo();
        const articleRepo = makeMockArticleRepo();
        const auditWriter = makeMockAuditWriter();
        const localEventBus = new EventBus();
        vi.spyOn(localEventBus, 'publish').mockResolvedValue(undefined);
        const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

        const mockScraper: MediaScraper = {
          listPageUrls: [],
          extractUrls() { return []; },
          parseArticle() {
            return { title: 'T', snippet: 'S', publishedAt: null, textContent: tc.textContent };
          },
        };
        const scraperLookup = vi.fn().mockReturnValue(mockScraper);

        const fetcher = new FetcherParser(
          articleRepo, mediaRepo, localEventBus, auditWriter, fetchHtml, scraperLookup,
        );

        const envelope = makeDiscoveredEnvelope(`https://www.eltiempo.com/always-${tc.expectedSource}`, 'eltiempo');
        await fetcher.handler()(envelope);

        const data = articleRepo.create.mock.calls[0][0];
        expect(data.textContentSource).toBe(tc.expectedSource);
        expect(data.textContentLen).toBe(tc.expectedLen);
        expect(data).toHaveProperty('textContentSource');
        expect(data).toHaveProperty('textContentLen');
        expect(data).toHaveProperty('paywallDetected');
        expect(data).toHaveProperty('usableForOverview');
        expect(data).toHaveProperty('extractionFailReason');
      }
    });
  });

  describe('paywall detection fixture', () => {
    it('detects paywall with keyword + sparse content (< 3 real paragraphs)', async () => {
      const paywallHtml = `<html><body>
        <div class="content-lock">
          <p>Suscríbase para continuar leyendo este artículo premium.</p>
        </div>
        <article>
          <p>${'A'.repeat(50)}</p>
        </article>
      </body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(paywallHtml);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Paywall Article', snippet: 'Locked', publishedAt: null, textContent: 'A'.repeat(900) };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/paywall-fixture', 'eltiempo');
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.paywallDetected).toBe(true);
      expect(data.extractionFailReason).toBe('paywall');
      expect(data.usableForOverview).toBe(false);
    });

    it('does not flag paywall when keywords are absent despite sparse content', async () => {
      const sparseHtml = `<html><body><article><p>${'A'.repeat(50)}</p></article></body></html>`;

      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue(sparseHtml);

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'Sparse Article', snippet: 'Sparse', publishedAt: null, textContent: 'A'.repeat(900) };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/no-paywall', 'eltiempo');
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.paywallDetected).toBe(false);
      expect(data.extractionFailReason).toBeNull();
      expect(data.usableForOverview).toBe(true);
    });
  });

  // =============================================
  // RSS METADATA FALLBACK TESTS
  // =============================================
  describe('RSS metadata fallback', () => {
    function makeRssDiscoveredEnvelope(
      url: string,
      mediaKey: string,
      rssMetadata: { rss_title?: string; rss_summary?: string; rss_published_at?: string } = {},
    ): EventEnvelope {
      return {
        event_name: 'ArticleDiscovered',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: ulid(), span_id: ulid(), source_module: 'rss' },
        payload: { url, media_key: mediaKey, discovered_at: new Date().toISOString(), ...rssMetadata },
      };
    }

    // TEST 1: RSS article with title + summary + publishedAt survives pipeline
    it('RSS article with title + summary + publishedAt persists successfully', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-1', mediaKey: 'prensa_rural', name: 'Prensa Rural',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      // StubScraper returns empty — simulates real scenario
      const stubScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { return { title: '', snippet: '', textContent: '', publishedAt: null }; },
      };
      const scraperLookup = vi.fn().mockReturnValue(stubScraper);
      const fetchHtml = vi.fn().mockResolvedValue('<html><body><p>Content</p></body></html>');

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeRssDiscoveredEnvelope(
        'https://prensarural.org/article-1', 'prensa_rural',
        {
          rss_title: 'Derechos campesinos en Colombia',
          rss_summary: 'Artículo sobre los derechos de los campesinos colombianos.',
          rss_published_at: '2026-03-10T12:00:00Z',
        },
      );
      await fetcher.handler()(envelope);

      expect(articleRepo.create).toHaveBeenCalledOnce();
      const data = articleRepo.create.mock.calls[0][0];
      expect(data.title).toBe('Derechos campesinos en Colombia');
      expect(data.snippet).toBe('Artículo sobre los derechos de los campesinos colombianos.');
      expect(data.publishedAt).toEqual(new Date('2026-03-10T12:00:00Z'));
      expect(data.status).toBe('NORMALIZED');

      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('ArticleNormalized');
    });

    // TEST 2: RSS article with empty HTML parser but valid RSS metadata → persists
    it('RSS article with empty HTML parser but valid RSS metadata persists', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-2', mediaKey: 'el_turbion', name: 'El Turbión',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      // StubScraper returns empty
      const stubScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { return { title: '', snippet: '', textContent: '', publishedAt: null }; },
      };
      const scraperLookup = vi.fn().mockReturnValue(stubScraper);
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeRssDiscoveredEnvelope(
        'https://elturbion.com/article-rss', 'el_turbion',
        {
          rss_title: 'Conflicto en el Cauca',
          rss_summary: 'Reportaje sobre el conflicto armado en el departamento del Cauca.',
        },
      );
      await fetcher.handler()(envelope);

      expect(articleRepo.create).toHaveBeenCalledOnce();
      const data = articleRepo.create.mock.calls[0][0];
      expect(data.title).toBe('Conflicto en el Cauca');
      expect(data.status).toBe('NORMALIZED');
    });

    // TEST 3: RSS article without sufficient metadata is blocked
    it('RSS article without title in RSS metadata is correctly blocked', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-3', mediaKey: 'la_cola_de_rata', name: 'La Cola de Rata',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const stubScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { return { title: '', snippet: '', textContent: '', publishedAt: null }; },
      };
      const scraperLookup = vi.fn().mockReturnValue(stubScraper);
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      // No rss_title in payload
      const envelope = makeRssDiscoveredEnvelope(
        'https://lacoladerata.co/no-title', 'la_cola_de_rata',
        { rss_summary: 'Only summary, no title' },
      );
      await fetcher.handler()(envelope);

      expect(articleRepo.create).not.toHaveBeenCalled();
      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('ArticlePolicyBlocked');
      expect(published[0].payload).toHaveProperty('reason_code', 'PARSE_FAIL');
    });

    // TEST 4: Non-RSS article maintains current behavior intact
    it('non-RSS article with good HTML parse maintains current behavior', async () => {
      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return { title: 'HTML Parsed Title', snippet: 'HTML snippet', publishedAt: new Date('2026-03-10'), textContent: 'A'.repeat(1000) };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      // source_module = 'ingestion' (NOT rss)
      const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/normal-article', 'eltiempo');
      await fetcher.handler()(envelope);

      expect(articleRepo.create).toHaveBeenCalledOnce();
      const data = articleRepo.create.mock.calls[0][0];
      expect(data.title).toBe('HTML Parsed Title');
      expect(data.status).toBe('NORMALIZED');
    });

    // TEST 5: Non-RSS article NEVER uses RSS fallback
    it('non-RSS article with empty title is blocked, never uses fallback', async () => {
      const mediaRepo = makeMockMediaRepo();
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      const mockScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { return { title: '', snippet: '', textContent: '', publishedAt: null }; },
      };
      const scraperLookup = vi.fn().mockReturnValue(mockScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      // Even if payload has rss_title — source_module is NOT 'rss', so fallback must not activate
      const envelope: EventEnvelope = {
        event_name: 'ArticleDiscovered',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: ulid(), span_id: ulid(), source_module: 'ingestion' },
        payload: {
          url: 'https://www.eltiempo.com/should-block',
          media_key: 'eltiempo',
          discovered_at: new Date().toISOString(),
          rss_title: 'This should never be used',
          rss_summary: 'This should never be used either',
        },
      };
      await fetcher.handler()(envelope);

      expect(articleRepo.create).not.toHaveBeenCalled();
      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('ArticlePolicyBlocked');
      expect(published[0].payload).toHaveProperty('reason_code', 'PARSE_FAIL');
    });

    // TEST 6: RSS article with good HTML parse is NOT degraded by fallback
    it('RSS article with good HTML parse keeps HTML-parsed data, no degradation', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-6', mediaKey: 'el_turbion', name: 'El Turbión',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      // HTML scraper DOES return good data
      const goodScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() {
          return {
            title: 'HTML Title (Better)',
            snippet: 'HTML snippet is more detailed',
            textContent: 'B'.repeat(1000),
            publishedAt: new Date('2026-03-15'),
          };
        },
      };
      const scraperLookup = vi.fn().mockReturnValue(goodScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeRssDiscoveredEnvelope(
        'https://elturbion.com/good-html', 'el_turbion',
        {
          rss_title: 'RSS Title (Worse)',
          rss_summary: 'RSS summary is less detailed',
          rss_published_at: '2026-03-01T00:00:00Z',
        },
      );
      await fetcher.handler()(envelope);

      expect(articleRepo.create).toHaveBeenCalledOnce();
      const data = articleRepo.create.mock.calls[0][0];
      // HTML-parsed data should be preserved, NOT overwritten by RSS fallback
      expect(data.title).toBe('HTML Title (Better)');
      expect(data.snippet).toBe('HTML snippet is more detailed');
      expect(data.publishedAt).toEqual(new Date('2026-03-15'));
      expect(data.textContentSource).toBe('body');
      expect(data.textContentLen).toBe(1000);
    });

    // TEST: RSS fallback text source in text acquisition ladder
    it('uses RSS summary as text source when HTML text is insufficient', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-7', mediaKey: 'prensa_rural', name: 'Prensa Rural',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      const stubScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { return { title: '', snippet: '', textContent: '', publishedAt: null }; },
      };
      const scraperLookup = vi.fn().mockReturnValue(stubScraper);

      const rssSummary = 'R'.repeat(300);
      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeRssDiscoveredEnvelope(
        'https://prensarural.org/rss-text', 'prensa_rural',
        { rss_title: 'RSS Text Test', rss_summary: rssSummary },
      );
      await fetcher.handler()(envelope);

      const data = articleRepo.create.mock.calls[0][0];
      expect(data.textContentSource).toBe('rss');
      expect(data.textContentLen).toBe(300);
    });

    // TEST: RSS parse exception is recovered via fallback
    it('RSS article recovers from parse exception via metadata fallback', async () => {
      const mediaRepo = makeMockMediaRepo();
      mediaRepo.findByKey.mockResolvedValue({
        id: 'media-rss-8', mediaKey: 'el_turbion', name: 'El Turbión',
        allowlisted: true, createdAt: new Date(),
      });
      const articleRepo = makeMockArticleRepo();
      const auditWriter = makeMockAuditWriter();
      const fetchHtml = vi.fn().mockResolvedValue('<html><body></body></html>');

      // Parser THROWS for RSS source
      const throwingScraper: MediaScraper = {
        listPageUrls: [],
        extractUrls() { return []; },
        parseArticle() { throw new Error('parse explosion'); },
      };
      const scraperLookup = vi.fn().mockReturnValue(throwingScraper);

      const fetcher = new FetcherParser(
        articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
      );

      const envelope = makeRssDiscoveredEnvelope(
        'https://elturbion.com/throws', 'el_turbion',
        { rss_title: 'Recovered Article', rss_summary: 'This was recovered from RSS metadata' },
      );
      await fetcher.handler()(envelope);

      expect(articleRepo.create).toHaveBeenCalledOnce();
      const data = articleRepo.create.mock.calls[0][0];
      expect(data.title).toBe('Recovered Article');
      expect(data.status).toBe('NORMALIZED');
    });
  });

  it('includes media_key in ArticlePolicyBlocked payload for DUPLICATE_URL', async () => {
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

    expect(published[0].payload).toHaveProperty('media_key', 'eltiempo');
  });

  it('includes media_key in ArticlePolicyBlocked payload for PARSE_FAIL', async () => {
    const mediaRepo = makeMockMediaRepo();
    const articleRepo = makeMockArticleRepo();
    const auditWriter = makeMockAuditWriter();
    const fetchHtml = vi.fn().mockRejectedValue(new Error('HTTP 500'));
    const scraperLookup = vi.fn();

    const fetcher = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    const envelope = makeDiscoveredEnvelope('https://www.eltiempo.com/test', 'eltiempo');
    await fetcher.handler()(envelope);

    expect(published[0].event_name).toBe('ArticlePolicyBlocked');
    expect(published[0].payload).toHaveProperty('media_key', 'eltiempo');
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
