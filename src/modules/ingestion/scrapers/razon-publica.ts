import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate } from './html-utils.js';

const LIST_PAGE_URL = 'https://razonpublica.com/';

export class RazonPublicaScraper implements MediaScraper {
  listPageUrls = [LIST_PAGE_URL];

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/razonpublica\.com\/[a-z0-9][\w-]*\/)["']/gi;
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

    return { title, snippet, publishedAt: isValidDate(publishedAt) ? publishedAt : null };
  }

  private isArticleUrl(url: string): boolean {
    // Exclude category, tag, author, page, and asset paths
    if (/\/(categoria|tag|author|page|wp-content|wp-json|feed)\//i.test(url)) return false;
    return /^https:\/\/razonpublica\.com\/[\w-]+\/$/.test(url);
  }
}
