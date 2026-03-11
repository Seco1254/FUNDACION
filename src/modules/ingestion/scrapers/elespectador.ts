import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, extractArticleBody, isValidDate } from './html-utils.js';

const LIST_PAGE_URL = 'https://www.elespectador.com/';

export class ElEspectadorScraper implements MediaScraper {
  listPageUrls = [LIST_PAGE_URL];

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/www\.elespectador\.com\/[^"']+)["']/gi;
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

    const textContent = extractArticleBody(html);
    return { title, snippet, textContent, publishedAt: isValidDate(publishedAt) ? publishedAt : null };
  }

  private isArticleUrl(url: string): boolean {
    // Reject noise paths: querystrings, fragments, file extensions, feed/author/tag pages
    if (/[?#]/.test(url)) return false;
    if (/\.(xml|rss|json|pdf|jpg|png|gif|svg)(\/?$)/i.test(url)) return false;
    if (/\/(outboundfeeds|autor|tag|rss|feed|autor-invitado)\//i.test(url)) return false;

    // Accept 2-4 path segments with optional trailing slash
    // e.g. /politica/slug/, /deportes/futbol-mundial/slug, /seccion/sub/sub2/slug
    return /^https:\/\/www\.elespectador\.com\/([\w-]+\/){1,3}[\w-]+\/?$/.test(url);
  }
}
