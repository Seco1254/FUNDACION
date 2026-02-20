import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { EventBus } from '../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../core/event_bus/envelope.js';
import { ScrapeOrchestrator } from './service/scrape-orchestrator.js';
import { FetcherParser } from './service/fetcher-parser.js';
import { PolicyGuard } from './service/policy-guard.js';
import { MediaScraper } from './domain/types.js';
import { ElTiempoScraper } from './scrapers/eltiempo.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `test/fixtures/${name}`), 'utf-8');
}

function loadEventSchema(name: string) {
  const raw = readFileSync(resolve(process.cwd(), `src/contracts/events/${name}.json`), 'utf-8');
  return JSON.parse(raw);
}

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

describe('Ingestion E2E pipeline (no internet)', () => {
  let published: EventEnvelope[];
  let articles: Map<string, Record<string, unknown>>;
  let articleIdCounter: number;

  beforeEach(() => {
    published = [];
    articles = new Map();
    articleIdCounter = 0;
  });

  it('full pipeline: list → discover → fetch → normalize → policy ok', async () => {
    const listHtml = loadFixture('eltiempo-list.html');
    const articleHtml = loadFixture('eltiempo-article.html');

    // Mock fetch: list page returns list fixture, article URLs return article fixture
    const fetchHtml = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://www.eltiempo.com/') return listHtml;
      return articleHtml;
    });

    const scraper = new ElTiempoScraper();
    const scraperLookup = vi.fn().mockReturnValue(scraper);

    const mediaRepo = {
      findAllAllowlisted: vi.fn().mockResolvedValue([
        { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date() },
      ]),
      findByKey: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date(),
      }),
      create: vi.fn(),
    } as any;

    const articleRepo = {
      findByUrl: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockImplementation(async (id: string) => articles.get(id) ?? null),
      create: vi.fn().mockImplementation(async (data: any) => {
        articleIdCounter++;
        const article = {
          id: `article-${articleIdCounter}`,
          ...data,
          createdAt: new Date(),
          textNorm: null,
          blockedReason: null,
        };
        articles.set(article.id, article);
        return article;
      }),
      updateStatus: vi.fn().mockImplementation(async (id: string, status: string, blockedReason?: string) => {
        const article = articles.get(id);
        if (article) {
          article.status = status;
          article.blockedReason = blockedReason ?? null;
        }
        return article;
      }),
    } as any;

    const auditWriter = { write: vi.fn().mockResolvedValue(undefined) };

    // Wire with real EventBus
    const eventBus = new EventBus();

    // Track all published events
    const origPublish = eventBus.publish.bind(eventBus);
    const wrappedPublish = async (env: EventEnvelope) => {
      published.push(env);
      return origPublish(env);
    };
    vi.spyOn(eventBus, 'publish').mockImplementation(wrappedPublish);

    const fetcherParser = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );
    const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);

    eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
    eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    // Run the pipeline
    const result = await orchestrator.run();

    expect(result.discovered).toBe(3);

    // Check events emitted in order
    const eventNames = published.map((e) => e.event_name);
    // For each article: ArticleDiscovered → ArticleNormalized → ArticlePolicyOk
    // 3 articles = 9 events
    expect(eventNames).toHaveLength(9);

    // Group by event type
    const discovered = published.filter((e) => e.event_name === 'ArticleDiscovered');
    const normalized = published.filter((e) => e.event_name === 'ArticleNormalized');
    const policyOk = published.filter((e) => e.event_name === 'ArticlePolicyOk');

    expect(discovered).toHaveLength(3);
    expect(normalized).toHaveLength(3);
    expect(policyOk).toHaveLength(3);

    // Articles in DB have POLICY_OK status
    for (const [, article] of articles) {
      expect(article.status).toBe('POLICY_OK');
      expect((article.snippet as string).length).toBeGreaterThan(0);
      expect((article.snippet as string).length).toBeLessThanOrEqual(600);
    }
  });

  it('validates emitted events against JSON schemas', async () => {
    const listHtml = loadFixture('eltiempo-list.html');
    const articleHtml = loadFixture('eltiempo-article.html');

    const fetchHtml = vi.fn().mockImplementation(async (url: string) => {
      if (url === 'https://www.eltiempo.com/') return listHtml;
      return articleHtml;
    });

    const scraper = new ElTiempoScraper();
    const scraperLookup = vi.fn().mockReturnValue(scraper);

    const mediaRepo = {
      findAllAllowlisted: vi.fn().mockResolvedValue([
        { id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date() },
      ]),
      findByKey: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true, createdAt: new Date(),
      }),
      create: vi.fn(),
    } as any;

    const articleRepo = {
      findByUrl: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockImplementation(async (id: string) => articles.get(id) ?? null),
      create: vi.fn().mockImplementation(async (data: any) => {
        articleIdCounter++;
        const article = {
          id: `article-${articleIdCounter}`,
          ...data,
          createdAt: new Date(),
          textNorm: null,
          blockedReason: null,
        };
        articles.set(article.id, article);
        return article;
      }),
      updateStatus: vi.fn().mockImplementation(async (id: string, status: string, blockedReason?: string) => {
        const article = articles.get(id);
        if (article) {
          article.status = status;
          article.blockedReason = blockedReason ?? null;
        }
        return article;
      }),
    } as any;

    const auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
    const eventBus = new EventBus();

    const origPublish = eventBus.publish.bind(eventBus);
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
      return origPublish(env);
    });

    const fetcherParser = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );
    const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);

    eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
    eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    await orchestrator.run();

    // Validate each event against its JSON schema
    const schemaMap: Record<string, ReturnType<typeof loadEventSchema>> = {
      ArticleDiscovered: loadEventSchema('ArticleDiscovered'),
      ArticleNormalized: loadEventSchema('ArticleNormalized'),
      ArticlePolicyOk: loadEventSchema('ArticlePolicyOk'),
      ArticlePolicyBlocked: loadEventSchema('ArticlePolicyBlocked'),
    };

    for (const event of published) {
      const eventName = event.event_name;
      const schema = schemaMap[eventName];
      if (schema) {
        const validate = ajv.compile(schema);
        const valid = validate(event);
        if (!valid) {
          console.error(`Schema validation failed for ${eventName}:`, validate.errors);
        }
        expect(valid).toBe(true);
      }
    }
  });

  it('pipeline blocks article with short snippet as NO_EXTRACT', async () => {
    const fetchHtml = vi.fn().mockImplementation(async () => {
      return `<html>
        <head>
          <meta property="og:title" content="Titulo corto">
          <meta property="og:description" content="Breve.">
        </head>
        <body><h1>Titulo corto</h1></body>
      </html>`;
    });

    const mockScraper: MediaScraper = {
      listPageUrls: ['https://test.com/'],
      extractUrls() { return ['https://test.com/art-1']; },
      parseArticle(html: string) {
        const titleMatch = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
        const snippetMatch = html.match(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);
        return {
          title: titleMatch?.[1] ?? '',
          snippet: snippetMatch?.[1] ?? '',
          publishedAt: null,
          textContent: '',
        };
      },
    };
    const scraperLookup = vi.fn().mockReturnValue(mockScraper);

    const mediaRepo = {
      findAllAllowlisted: vi.fn().mockResolvedValue([
        { id: 'media-1', mediaKey: 'test', name: 'Test', allowlisted: true, createdAt: new Date() },
      ]),
      findByKey: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'test', name: 'Test', allowlisted: true, createdAt: new Date(),
      }),
      findById: vi.fn().mockResolvedValue({
        id: 'media-1', mediaKey: 'test', name: 'Test', allowlisted: true, createdAt: new Date(),
      }),
      create: vi.fn(),
    } as any;

    const articleRepo = {
      findByUrl: vi.fn().mockResolvedValue(null),
      findById: vi.fn().mockImplementation(async (id: string) => articles.get(id) ?? null),
      create: vi.fn().mockImplementation(async (data: any) => {
        articleIdCounter++;
        const article = {
          id: `article-${articleIdCounter}`,
          ...data,
          createdAt: new Date(),
          textNorm: null,
          blockedReason: null,
        };
        articles.set(article.id, article);
        return article;
      }),
      updateStatus: vi.fn().mockImplementation(async (id: string, status: string, blockedReason?: string) => {
        const article = articles.get(id);
        if (article) {
          article.status = status;
          article.blockedReason = blockedReason ?? null;
        }
        return article;
      }),
    } as any;

    const auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
    const eventBus = new EventBus();

    const origPublish = eventBus.publish.bind(eventBus);
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
      return origPublish(env);
    });

    const fetcherParser = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );
    const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditWriter);

    eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
    eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditWriter, fetchHtml, scraperLookup,
    );

    await orchestrator.run();

    const blocked = published.filter((e) => e.event_name === 'ArticlePolicyBlocked');
    expect(blocked).toHaveLength(1);
    expect(blocked[0].payload).toHaveProperty('reason_code', 'NO_EXTRACT');

    const [, article] = [...articles.entries()][0];
    expect(article.status).toBe('POLICY_BLOCKED');
    expect(article.blockedReason).toBe('NO_EXTRACT');
  });
});
