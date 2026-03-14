/**
 * RSS Feed Registry — typed catalog of RSS sources for discovery.
 *
 * Each entry maps a mediaKey (matching the Media table) to its RSS feed URL
 * and metadata. Adding a new source = adding one entry here + one row in seeds.
 */

export interface RssFeedEntry {
  mediaKey: string;
  name: string;
  feedUrl: string;
  homepage: string;
  sourceType: 'rss';
  enabled: boolean;
}

export const RSS_FEEDS: readonly RssFeedEntry[] = [
  {
    mediaKey: 'servindi',
    name: 'Servindi',
    feedUrl: 'https://www.servindi.org/feed',
    homepage: 'https://www.servindi.org',
    sourceType: 'rss',
    enabled: true,
  },
  {
    mediaKey: 'prensa_rural',
    name: 'Agencia Prensa Rural',
    feedUrl: 'https://prensarural.org/spip/backend.php3',
    homepage: 'https://prensarural.org',
    sourceType: 'rss',
    enabled: true,
  },
  {
    mediaKey: 'el_turbion',
    name: 'El Turbión',
    feedUrl: 'https://elturbion.com/feed',
    homepage: 'https://elturbion.com',
    sourceType: 'rss',
    enabled: true,
  },
  {
    mediaKey: 'la_cola_de_rata',
    name: 'La Cola de Rata',
    feedUrl: 'https://www.lacoladerata.co/feed/',
    homepage: 'https://www.lacoladerata.co',
    sourceType: 'rss',
    enabled: true,
  },
] as const;

/** Get only enabled feeds. */
export function getEnabledFeeds(): RssFeedEntry[] {
  return RSS_FEEDS.filter((f) => f.enabled);
}
