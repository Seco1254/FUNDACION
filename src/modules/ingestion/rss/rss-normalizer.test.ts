import { describe, it, expect } from 'vitest';
import { normalizeRssItem, canonicalizeUrl, decodeEntities } from './rss-normalizer.js';
import { RssRawItem } from './rss-parser.js';

describe('canonicalizeUrl', () => {
  it('returns null for empty input', () => {
    expect(canonicalizeUrl('')).toBeNull();
    expect(canonicalizeUrl(undefined)).toBeNull();
  });

  it('returns null for invalid URLs', () => {
    expect(canonicalizeUrl('not-a-url')).toBeNull();
    expect(canonicalizeUrl('ftp://example.com')).toBeNull();
  });

  it('preserves valid URLs', () => {
    expect(canonicalizeUrl('https://example.com/article')).toBe('https://example.com/article');
  });

  it('strips trailing slashes (non-root)', () => {
    expect(canonicalizeUrl('https://example.com/article/')).toBe('https://example.com/article');
  });

  it('keeps root slash', () => {
    const result = canonicalizeUrl('https://example.com/');
    expect(result).toBe('https://example.com/');
  });

  it('removes tracking params', () => {
    const url = 'https://example.com/article?utm_source=rss&utm_medium=feed&id=123';
    const result = canonicalizeUrl(url);
    expect(result).toBe('https://example.com/article?id=123');
  });

  it('removes fragment', () => {
    expect(canonicalizeUrl('https://example.com/article#section')).toBe('https://example.com/article');
  });

  it('removes all tracking params', () => {
    const url = 'https://example.com/a?utm_source=x&utm_medium=y&utm_campaign=z&utm_content=w&utm_term=v&fbclid=abc&gclid=def';
    const result = canonicalizeUrl(url);
    expect(result).toBe('https://example.com/a');
  });
});

describe('normalizeRssItem', () => {
  const baseItem: RssRawItem = {
    title: 'Derechos humanos en Colombia',
    link: 'https://example.com/derechos-humanos',
    guid: 'https://example.com/derechos-humanos',
    pubDate: 'Mon, 10 Mar 2026 12:00:00 GMT',
    description: 'Artículo sobre derechos humanos.',
    category: ['Derechos Humanos', 'Colombia'],
  };

  it('normalizes a complete RSS item', () => {
    const result = normalizeRssItem(baseItem, 'servindi', 'https://servindi.org/feed');
    expect(result).not.toBeNull();
    expect(result!.mediaKey).toBe('servindi');
    expect(result!.feedUrl).toBe('https://servindi.org/feed');
    expect(result!.url).toBe('https://example.com/derechos-humanos');
    expect(result!.title).toBe('Derechos humanos en Colombia');
    expect(result!.publishedAt).toBeInstanceOf(Date);
    expect(result!.categories).toEqual(['Derechos Humanos', 'Colombia']);
    expect(result!.summary).toBe('Artículo sobre derechos humanos.');
    expect(result!.guid).toBe('https://example.com/derechos-humanos');
  });

  it('returns null for item without link', () => {
    const noLink: RssRawItem = { title: 'No link', description: 'test' };
    expect(normalizeRssItem(noLink, 'servindi', 'https://servindi.org/feed')).toBeNull();
  });

  it('returns null for item without title', () => {
    const noTitle: RssRawItem = { link: 'https://example.com/notitle' };
    expect(normalizeRssItem(noTitle, 'servindi', 'https://servindi.org/feed')).toBeNull();
  });

  it('uses canonical URL as identity key', () => {
    const result = normalizeRssItem(baseItem, 'servindi', 'https://servindi.org/feed');
    expect(result!.identityKey).toBe('https://example.com/derechos-humanos');
  });

  it('strips tracking params from URL', () => {
    const tracked: RssRawItem = {
      ...baseItem,
      link: 'https://example.com/article?utm_source=rss&id=42',
    };
    const result = normalizeRssItem(tracked, 'servindi', 'https://servindi.org/feed');
    expect(result!.url).toBe('https://example.com/article?id=42');
  });

  it('handles missing pubDate gracefully', () => {
    const noPubDate: RssRawItem = {
      title: 'Sin fecha',
      link: 'https://example.com/sin-fecha',
    };
    const result = normalizeRssItem(noPubDate, 'servindi', 'https://servindi.org/feed');
    expect(result!.publishedAt).toBeNull();
  });

  it('handles missing categories', () => {
    const noCat: RssRawItem = {
      title: 'Sin categoría',
      link: 'https://example.com/sin-cat',
    };
    const result = normalizeRssItem(noCat, 'servindi', 'https://servindi.org/feed');
    expect(result!.categories).toEqual([]);
  });

  it('uses dc:date when pubDate is absent (Prensa Rural RDF)', () => {
    const rdfItem: RssRawItem = {
      title: 'Artículo con dc:date',
      link: 'https://prensarural.org/spip/spip.php?article999',
      'dc:date': '2026-03-08T14:30:00-05:00',
    };
    const result = normalizeRssItem(rdfItem, 'prensa_rural', 'https://prensarural.org/spip/backend.php3');
    expect(result).not.toBeNull();
    expect(result!.publishedAt).toBeInstanceOf(Date);
    expect(result!.publishedAt!.toISOString()).toBe('2026-03-08T19:30:00.000Z');
  });

  it('prefers pubDate over dc:date when both present', () => {
    const item: RssRawItem = {
      title: 'Both dates',
      link: 'https://example.com/both-dates',
      pubDate: 'Mon, 10 Mar 2026 12:00:00 GMT',
      'dc:date': '2026-01-01T00:00:00Z',
    };
    const result = normalizeRssItem(item, 'test', 'https://example.com/feed');
    expect(result!.publishedAt!.toISOString()).toBe('2026-03-10T12:00:00.000Z');
  });

  it('decodes HTML entities in title', () => {
    const item: RssRawItem = {
      title: 'Comunidades ind&#237;genas exigen justicia &amp; paz',
      link: 'https://example.com/entities',
      pubDate: 'Mon, 10 Mar 2026 12:00:00 GMT',
    };
    const result = normalizeRssItem(item, 'test', 'https://example.com/feed');
    expect(result!.title).toBe('Comunidades indígenas exigen justicia & paz');
  });

  it('decodes HTML entities in summary', () => {
    const item: RssRawItem = {
      title: 'Test',
      link: 'https://example.com/entities-summary',
      description: 'La situaci&#243;n pol&#237;tica &amp; econ&#243;mica',
    };
    const result = normalizeRssItem(item, 'test', 'https://example.com/feed');
    expect(result!.summary).toBe('La situación política & económica');
  });

  it('truncates summary to 1000 chars', () => {
    const longDesc: RssRawItem = {
      title: 'Long',
      link: 'https://example.com/long',
      description: 'x'.repeat(2000),
    };
    const result = normalizeRssItem(longDesc, 'servindi', 'https://servindi.org/feed');
    expect(result!.summary!.length).toBe(1000);
  });

  it('generates hash identity when no URL or useful GUID', () => {
    const noGuid: RssRawItem = {
      title: 'Hash me',
      link: 'https://example.com/hash',
      guid: 'true', // not useful
    };
    const result = normalizeRssItem(noGuid, 'servindi', 'https://servindi.org/feed');
    // identity key should be the canonical URL (primary), not hash
    expect(result!.identityKey).toBe('https://example.com/hash');
  });
});

describe('decodeEntities', () => {
  it('decodes numeric entities', () => {
    expect(decodeEntities('&#237;')).toBe('í');
    expect(decodeEntities('&#243;')).toBe('ó');
  });

  it('decodes hex entities', () => {
    expect(decodeEntities('&#xE9;')).toBe('é');
    expect(decodeEntities('&#xF1;')).toBe('ñ');
  });

  it('decodes named entities', () => {
    expect(decodeEntities('&amp;')).toBe('&');
    expect(decodeEntities('&lt;')).toBe('<');
    expect(decodeEntities('&gt;')).toBe('>');
    expect(decodeEntities('&quot;')).toBe('"');
    expect(decodeEntities('&apos;')).toBe("'");
  });

  it('decodes Spanish named entities', () => {
    expect(decodeEntities('&aacute;&eacute;&iacute;&oacute;&uacute;')).toBe('áéíóú');
    expect(decodeEntities('&ntilde;')).toBe('ñ');
    expect(decodeEntities('&Ntilde;')).toBe('Ñ');
  });

  it('handles mixed entities in a sentence', () => {
    expect(decodeEntities('Pol&#237;tica &amp; justicia en Bogot&#225;'))
      .toBe('Política & justicia en Bogotá');
  });

  it('returns plain text unchanged', () => {
    expect(decodeEntities('Hello World')).toBe('Hello World');
  });
});
