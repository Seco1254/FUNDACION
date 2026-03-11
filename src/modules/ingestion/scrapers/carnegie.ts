import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate, extractArticleBody } from './html-utils.js';

const LIST_PAGES = [
  'https://carnegieendowment.org/posts',
];

export class CarnegieScraper implements MediaScraper {
  listPageUrls = LIST_PAGES;

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/carnegieendowment\.org\/[^"']+)["']/gi;
    let match;
    while ((match = hrefRegex.exec(html)) !== null) {
      if (this.isArticleUrl(match[1])) {
        urls.push(match[1]);
      }
    }
    return [...new Set(urls)];
  }

  parseArticle(html: string, _url: string): ParsedArticle {
    const title = extractMeta(html, 'og:title') ?? extractH1(html) ?? '';
    const snippet = extractMeta(html, 'og:description') ?? extractLeadParagraph(html) ?? '';
    const dateStr =
      extractMeta(html, 'article:published_time') ??
      extractMeta(html, 'datePublished');
    const publishedAt = dateStr ? new Date(dateStr) : null;
    const textContent = extractArticleBody(html);
    return { title, snippet, publishedAt: isValidDate(publishedAt) ? publishedAt : null, textContent };
  }

  private isArticleUrl(url: string): boolean {
    // Allowed: /commentary/ and /analysis/ paths (research articles)
    if (!/\/(commentary|analysis)\//.test(url)) return false;
    // Block events, about, press
    if (/\/(events|about|press|donate)\//i.test(url)) return false;
    return /^https:\/\/carnegieendowment\.org\/(commentary|analysis)\/[\w-]+$/.test(url);
  }
}
