import { MediaScraper, ParsedArticle } from '../domain/types.js';

/**
 * StubScraper — no-op scraper for RSS-only media sources.
 *
 * Contract:
 * - listPageUrls = [] → ScrapeOrchestrator skips HTML discovery for these sources.
 * - parseArticle() returns empty fields intentionally. For RSS-discovered articles,
 *   FetcherParser applies an RSS metadata fallback (title/snippet/publishedAt from the
 *   feed payload) ONLY when source_module === 'rss'. This means RSS articles survive
 *   even though StubScraper can't extract anything from the HTML page.
 * - Non-RSS articles are never routed through StubScraper in normal operation.
 */
export class StubScraper implements MediaScraper {
  listPageUrls: string[] = [];

  extractUrls(_html: string): string[] {
    return [];
  }

  parseArticle(_html: string, _url: string): ParsedArticle {
    return { title: '', snippet: '', textContent: '', publishedAt: null };
  }
}
