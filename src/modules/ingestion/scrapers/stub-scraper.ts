import { MediaScraper, ParsedArticle } from '../domain/types.js';

export class StubScraper implements MediaScraper {
  listPageUrls: string[] = [];

  extractUrls(_html: string): string[] {
    return [];
  }

  parseArticle(_html: string, _url: string): ParsedArticle {
    return { title: '', snippet: '', textContent: '', publishedAt: null };
  }
}
