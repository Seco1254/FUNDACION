import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate } from './html-utils.js';

// Use the Google Discover RSS feed — static HTML returns almost no article links (SPA)
const LIST_PAGE_URL = 'https://www.elespectador.com/arc/outboundfeeds/discover/?outputType=xml';

export class ElEspectadorScraper implements MediaScraper {
  listPageUrls = [LIST_PAGE_URL];

  extractUrls(html: string): string[] {
    // Parse RSS XML: extract <link> and <guid> elements
    const urls: string[] = [];

    // <link>https://...</link> in RSS items
    const linkRegex = /<link>(https:\/\/www\.elespectador\.com\/[^<]+)<\/link>/gi;
    let match;
    while ((match = linkRegex.exec(html)) !== null) {
      if (this.isArticleUrl(match[1])) urls.push(match[1]);
    }

    // <guid isPermaLink="true">https://...</guid>
    const guidRegex = /<guid[^>]*>(https:\/\/www\.elespectador\.com\/[^<]+)<\/guid>/gi;
    while ((match = guidRegex.exec(html)) !== null) {
      if (this.isArticleUrl(match[1])) urls.push(match[1]);
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
    // Must have at least 2 path segments, no query strings (except feed URL itself)
    const path = url.replace('https://www.elespectador.com', '');
    if (!path || path.length < 5) return false;
    if (path.includes('arc/outboundfeeds')) return false;
    if (path.includes('podcast')) return false;
    return /^\/[\w-]+(\/[\w-]+)+\/?$/.test(path);
  }
}
