/**
 * RSS Parser — parses raw XML into typed RSS items.
 *
 * Handles both RSS 2.0 (<rss><channel><item>) and Atom (<feed><entry>) formats.
 * Uses fast-xml-parser for zero-dependency XML parsing.
 */

import { XMLParser } from 'fast-xml-parser';

export interface RssRawItem {
  title?: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  /** Atom: <published> or <updated> */
  published?: string;
  updated?: string;
  description?: string;
  /** content:encoded (RSS 2.0 full body) */
  'content:encoded'?: string;
  /** Atom: <summary> */
  summary?: string;
  /** RSS 2.0: <category> (string or string[]) */
  category?: string | string[];
}

export interface ParsedRssResult {
  items: RssRawItem[];
  feedTitle?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  // Preserve CDATA content
  cdataPropName: '__cdata',
  // Don't parse text nodes as numbers/booleans
  parseTagValue: false,
  // Handle arrays for repeated tags
  isArray: (name) => ['item', 'entry', 'category'].includes(name),
});

/**
 * Parse raw XML string into structured RSS items.
 * Supports RSS 2.0 and Atom formats.
 */
export function parseRssXml(xml: string): ParsedRssResult {
  const parsed = parser.parse(xml);

  // RSS 2.0: <rss><channel><item>
  if (parsed.rss?.channel) {
    const channel = parsed.rss.channel;
    const rawItems: unknown[] = channel.item ?? [];
    return {
      feedTitle: extractText(channel.title),
      items: rawItems.map(normalizeRss2Item),
    };
  }

  // Atom: <feed><entry>
  if (parsed.feed?.entry) {
    const feed = parsed.feed;
    const rawEntries: unknown[] = feed.entry ?? [];
    return {
      feedTitle: extractText(feed.title),
      items: rawEntries.map(normalizeAtomEntry),
    };
  }

  // RDF/RSS 1.0: <rdf:RDF><item>
  const rdfKey = Object.keys(parsed).find((k) => k.toLowerCase().includes('rdf'));
  if (rdfKey && parsed[rdfKey]?.item) {
    const rawItems: unknown[] = parsed[rdfKey].item ?? [];
    return {
      feedTitle: extractText(parsed[rdfKey].channel?.title),
      items: rawItems.map(normalizeRss2Item),
    };
  }

  return { items: [] };
}

function extractText(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
    if (typeof obj.__cdata === 'string') return obj.__cdata;
  }
  return undefined;
}

function normalizeRss2Item(raw: unknown): RssRawItem {
  const item = raw as Record<string, unknown>;
  const categories = normalizeCategories(item.category);

  return {
    title: extractText(item.title),
    link: extractText(item.link),
    guid: extractGuid(item.guid),
    pubDate: extractText(item.pubDate),
    description: extractText(item.description),
    'content:encoded': extractText(item['content:encoded']),
    ...(categories.length > 0 ? { category: categories } : {}),
  };
}

function normalizeAtomEntry(raw: unknown): RssRawItem {
  const entry = raw as Record<string, unknown>;

  // Atom links can be objects with @_href
  let link: string | undefined;
  if (typeof entry.link === 'string') {
    link = entry.link;
  } else if (entry.link && typeof entry.link === 'object') {
    const linkObj = entry.link as Record<string, unknown>;
    link = typeof linkObj['@_href'] === 'string' ? linkObj['@_href'] : undefined;
  }

  const categories = normalizeCategories(entry.category);

  return {
    title: extractText(entry.title),
    link,
    guid: extractText(entry.id),
    published: extractText(entry.published),
    updated: extractText(entry.updated),
    summary: extractText(entry.summary),
    description: extractText(entry.content),
    ...(categories.length > 0 ? { category: categories } : {}),
  };
}

function extractGuid(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj['#text'] === 'string') return obj['#text'];
  }
  return undefined;
}

function normalizeCategories(val: unknown): string[] {
  if (!val) return [];
  if (typeof val === 'string') return [val];
  if (Array.isArray(val)) {
    return val.map((c) => {
      if (typeof c === 'string') return c;
      if (c && typeof c === 'object') {
        const obj = c as Record<string, unknown>;
        return (typeof obj['#text'] === 'string' ? obj['#text'] : typeof obj['@_term'] === 'string' ? obj['@_term'] : '') as string;
      }
      return '';
    }).filter((c) => c.length > 0);
  }
  return [];
}
