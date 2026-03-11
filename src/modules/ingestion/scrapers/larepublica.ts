import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate, extractArticleBody } from './html-utils.js';

const LIST_PAGES = [
  'https://www.larepublica.co/economia',
  'https://www.larepublica.co/finanzas',
  'https://www.larepublica.co/empresas',
  'https://www.larepublica.co/globoeconomia',
];

export class LaRepublicaScraper implements MediaScraper {
  listPageUrls = LIST_PAGES;

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/www\.larepublica\.co\/[^"']+)["']/gi;
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
    // Allowed sections: /economia/, /empresas/, /finanzas/, /politica/, /globoeconomia/
    if (!/\/(economia|empresas|finanzas|politica|globoeconomia)\//.test(url)) return false;
    // Block opinion, podcasts, specials
    if (/\/(opinion|podcast|especiales|multimedia|infografia)\//i.test(url)) return false;
    // Must have a slug segment after section
    return /^https:\/\/www\.larepublica\.co\/[\w-]+\/[\w-]+-\d+$/.test(url);
  }
}
