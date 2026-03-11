import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate, extractArticleBody } from './html-utils.js';

const LIST_PAGES = [
  'https://www.crisisgroup.org/latin-america-caribbean',
];

export class CrisisGroupScraper implements MediaScraper {
  listPageUrls = LIST_PAGES;

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/www\.crisisgroup\.org\/[^"']+)["']/gi;
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
    // Allowed: /latin-america-caribbean/ and general /analysis/ paths
    if (!/\/(latin-america-caribbean|latin-america|analysis)\//.test(url)) return false;
    // Block press releases, about
    if (/\/(press|about|donate|careers)\//i.test(url)) return false;
    // Must have a slug (at least 2 path segments)
    return /^https:\/\/www\.crisisgroup\.org\/[\w-]+\/[\w-]+/.test(url);
  }
}
