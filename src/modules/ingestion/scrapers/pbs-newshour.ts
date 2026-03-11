import { MediaScraper, ParsedArticle } from '../domain/types.js';
import { extractMeta, extractH1, extractLeadParagraph, isValidDate, extractArticleBody } from './html-utils.js';

const LIST_PAGES = [
  'https://www.pbs.org/newshour/politics',
  'https://www.pbs.org/newshour/economy',
  'https://www.pbs.org/newshour/world',
];

export class PbsNewshourScraper implements MediaScraper {
  listPageUrls = LIST_PAGES;

  extractUrls(html: string): string[] {
    const urls: string[] = [];
    const hrefRegex = /href=["'](https:\/\/www\.pbs\.org\/newshour\/[^"']+)["']/gi;
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
    // Allowed sections: /politics/, /economy/, /world/
    if (!/\/newshour\/(politics|economy|world)\//.test(url)) return false;
    // Block video and show pages
    if (/\/(video|show|about|schedule)\//i.test(url)) return false;
    // Must have a slug after section
    return /^https:\/\/www\.pbs\.org\/newshour\/[\w-]+\/[\w-]+$/.test(url);
  }
}
