export interface ParsedArticle {
  title: string;
  snippet: string;
  textContent: string;
  publishedAt: Date | null;
}

export interface MediaScraper {
  listPageUrls: string[];
  extractUrls(html: string): string[];
  parseArticle(html: string, url: string): ParsedArticle;
}

export type FetchHtml = (url: string) => Promise<string>;
export type ScraperLookup = (mediaKey: string) => MediaScraper;
