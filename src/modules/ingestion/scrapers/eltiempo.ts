import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate } from './html-utils.js';

const LIST_PAGE_URL = 'https://www.eltiempo.com/';

export class ElTiempoScraper implements MediaScraper {
  listPageUrls = [LIST_PAGE_URL];

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/www\.eltiempo\.com\/[^"']+)["']/gi;
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
    const dateStr = extractMeta(html, 'article:published_time');
    const publishedAt = dateStr ? new Date(dateStr) : null;

    return { title, snippet, publishedAt: isValidDate(publishedAt) ? publishedAt : null };
  }

  private isArticleUrl(url: string): boolean {
    return /^https:\/\/www\.eltiempo\.com\/[\w-]+\/[\w-]+-\d+$/.test(url);
  }
}
