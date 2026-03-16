import { describe, it, expect } from 'vitest';
import { parseRssXml } from './rss-parser.js';

const VALID_RSS2 = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <item>
      <title>Artículo sobre derechos humanos</title>
      <link>https://example.com/articulo-1</link>
      <guid>https://example.com/articulo-1</guid>
      <pubDate>Mon, 10 Mar 2026 12:00:00 GMT</pubDate>
      <description>Descripción del artículo sobre derechos humanos en Colombia.</description>
      <category>Derechos Humanos</category>
      <category>Colombia</category>
    </item>
    <item>
      <title>Conflicto social en el Cauca</title>
      <link>https://example.com/articulo-2</link>
      <pubDate>Sun, 09 Mar 2026 08:00:00 GMT</pubDate>
      <description>Reportaje sobre conflicto social.</description>
    </item>
  </channel>
</rss>`;

const VALID_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <entry>
    <title>Entrada Atom</title>
    <link href="https://atom.example.com/entry-1"/>
    <id>urn:uuid:12345</id>
    <published>2026-03-10T12:00:00Z</published>
    <summary>Resumen de la entrada.</summary>
  </entry>
</feed>`;

describe('parseRssXml', () => {
  it('parses RSS 2.0 items correctly', () => {
    const result = parseRssXml(VALID_RSS2);
    expect(result.feedTitle).toBe('Test Feed');
    expect(result.items).toHaveLength(2);

    const first = result.items[0];
    expect(first.title).toBe('Artículo sobre derechos humanos');
    expect(first.link).toBe('https://example.com/articulo-1');
    expect(first.guid).toBe('https://example.com/articulo-1');
    expect(first.pubDate).toBe('Mon, 10 Mar 2026 12:00:00 GMT');
    expect(first.description).toBe('Descripción del artículo sobre derechos humanos en Colombia.');
    expect(first.category).toEqual(['Derechos Humanos', 'Colombia']);

    const second = result.items[1];
    expect(second.title).toBe('Conflicto social en el Cauca');
    expect(second.link).toBe('https://example.com/articulo-2');
  });

  it('parses Atom feed entries', () => {
    const result = parseRssXml(VALID_ATOM);
    expect(result.feedTitle).toBe('Atom Feed');
    expect(result.items).toHaveLength(1);

    const entry = result.items[0];
    expect(entry.title).toBe('Entrada Atom');
    expect(entry.link).toBe('https://atom.example.com/entry-1');
    expect(entry.guid).toBe('urn:uuid:12345');
    expect(entry.published).toBe('2026-03-10T12:00:00Z');
    expect(entry.summary).toBe('Resumen de la entrada.');
  });

  it('returns empty items for invalid XML', () => {
    const result = parseRssXml('<html><body>Not XML</body></html>');
    expect(result.items).toHaveLength(0);
  });

  it('returns empty items for empty string', () => {
    const result = parseRssXml('');
    expect(result.items).toHaveLength(0);
  });

  it('handles RSS with CDATA in title', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>CDATA Feed</title>
    <item>
      <title><![CDATA[Título con <especiales>]]></title>
      <link>https://example.com/cdata</link>
    </item>
  </channel>
</rss>`;
    const result = parseRssXml(xml);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toContain('Título con');
  });

  it('parses RDF/RSS 1.0 with dc:date (Prensa Rural format)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>Prensa Rural</title>
  </channel>
  <item>
    <title>Comunidades campesinas exigen tierras</title>
    <link>https://prensarural.org/spip/spip.php?article12345</link>
    <dc:date>2026-03-08T14:30:00-05:00</dc:date>
    <description>Las comunidades campesinas del norte del Cauca exigen restitución de tierras.</description>
  </item>
</rdf:RDF>`;
    const result = parseRssXml(xml);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].title).toBe('Comunidades campesinas exigen tierras');
    expect(result.items[0]['dc:date']).toBe('2026-03-08T14:30:00-05:00');
    expect(result.items[0].link).toBe('https://prensarural.org/spip/spip.php?article12345');
  });

  it('handles RSS with single category (not array)', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Single cat</title>
      <link>https://example.com/single</link>
      <category>Ambiente</category>
    </item>
  </channel>
</rss>`;
    const result = parseRssXml(xml);
    expect(result.items[0].category).toEqual(['Ambiente']);
  });
});
