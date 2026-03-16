/**
 * Fetch RSS feeds and display item details for editorial audit.
 */
import { parseRssXml } from '../src/modules/ingestion/rss/rss-parser.js';
import { normalizeRssItem } from '../src/modules/ingestion/rss/rss-normalizer.js';

async function main() {
  const feeds = [
    { key: 'servindi', url: 'https://www.servindi.org/feed' },
    { key: 'prensa_rural', url: 'https://prensarural.org/spip/backend.php3' },
    { key: 'el_turbion', url: 'https://elturbion.com/feed' },
    { key: 'la_cola_de_rata', url: 'https://www.lacoladerata.co/feed/' },
  ];

  for (const f of feeds) {
    try {
      const res = await fetch(f.url, { signal: AbortSignal.timeout(15000) });
      const xml = await res.text();
      const parsed = parseRssXml(xml);
      console.log('\n=== ' + f.key + ' === (' + parsed.items.length + ' items)');
      for (const item of parsed.items) {
        const norm = normalizeRssItem(item, f.key, f.url);
        if (norm) {
          console.log(JSON.stringify({
            title: norm.title.slice(0, 120),
            url: norm.url,
            publishedAt: norm.publishedAt?.toISOString() || null,
            categories: norm.categories.slice(0, 3),
            hasSummary: !!norm.summary,
          }));
        }
      }
    } catch (err: any) {
      console.log('\n=== ' + f.key + ' === FETCH FAILED: ' + err.message);
    }
  }
}
main();
