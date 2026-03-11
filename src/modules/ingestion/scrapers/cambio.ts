import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate, extractArticleBody } from './html-utils.js';

const LIST_PAGES = [
  'https://cambiocolombia.com/pais',
  'https://cambiocolombia.com/economia',
  'https://cambiocolombia.com/politica',
];

export class CambioScraper implements MediaScraper {
  listPageUrls = LIST_PAGES;

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/cambiocolombia\.com\/[^"']+)["']/gi;
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
    // Allowed sections: /pais/, /economia/, /politica/
    if (!/\/(pais|economia|politica)\//.test(url)) return false;
    // Block opinion, columnists
    if (/\/(opinion|columnistas|autor)\//i.test(url)) return false;
    // Must have slug after section
    return /^https:\/\/cambiocolombia\.com\/[\w-]+\/[\w-]+/.test(url);
  }
}
