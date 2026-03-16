/**
 * RSS Normalizer — transforms raw RSS items into a canonical discovery shape.
 *
 * Handles URL canonicalization, date parsing, and identity key generation
 * for deduplication.
 */

import { createHash } from 'crypto';
import { RssRawItem } from './rss-parser.js';

export interface RssDiscoveredItem {
  mediaKey: string;
  feedUrl: string;
  url: string;
  /** Canonical identity key for dedup: canonicalized URL, or GUID, or hash(title+publishedAt) */
  identityKey: string;
  title: string;
  publishedAt: Date | null;
  categories: string[];
  summary: string | null;
  guid: string | null;
}

/**
 * Normalize a raw RSS item into a canonical discovery shape.
 * Returns null if the item has no usable URL (link is required).
 */
export function normalizeRssItem(
  raw: RssRawItem,
  mediaKey: string,
  feedUrl: string,
): RssDiscoveredItem | null {
  const url = canonicalizeUrl(raw.link);
  if (!url) return null;

  const title = (raw.title ?? '').trim();
  if (!title) return null;

  const publishedAt = parseRssDate(raw.pubDate ?? raw.published ?? raw.updated);
  const guid = raw.guid ?? null;
  const summary = raw.description ?? raw['content:encoded'] ?? raw.summary ?? null;

  const categories = Array.isArray(raw.category)
    ? raw.category
    : raw.category
      ? [raw.category]
      : [];

  // Identity key: prefer canonical URL, fallback to GUID, fallback to hash(title+date)
  const identityKey = url || (guid && isUsefulGuid(guid) ? guid : hashIdentity(title, publishedAt));

  return {
    mediaKey,
    feedUrl,
    url,
    identityKey,
    title,
    publishedAt,
    categories,
    summary: summary ? summary.slice(0, 1000) : null,
    guid,
  };
}

/**
 * Canonicalize a URL: strip trailing slashes, fragments, common tracking params.
 * Returns null for invalid/empty URLs.
 */
export function canonicalizeUrl(raw: string | undefined): string | null {
  if (!raw || !raw.trim()) return null;

  let urlStr = raw.trim();

  // Ensure it's a valid absolute URL
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return null;
  }

  // Only accept http/https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  // Remove tracking params
  const trackingParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'fbclid', 'gclid'];
  for (const param of trackingParams) {
    parsed.searchParams.delete(param);
  }

  // Remove fragment
  parsed.hash = '';

  // Normalize to string, strip trailing slash for path-only URLs
  urlStr = parsed.toString();
  if (urlStr.endsWith('/') && parsed.pathname !== '/') {
    urlStr = urlStr.slice(0, -1);
  }

  return urlStr;
}

/** Parse an RSS date string (RFC 2822, ISO 8601, or common variants). */
function parseRssDate(raw: string | undefined): Date | null {
  if (!raw) return null;

  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;

  // Reject dates too far in the future (> 1 day) or too old (> 2 years)
  const now = Date.now();
  if (d.getTime() > now + 86400000) return null;
  if (d.getTime() < now - 2 * 365 * 86400000) return null;

  return d;
}

/** Check if a GUID is meaningful (not just "true" or empty-ish). */
function isUsefulGuid(guid: string): boolean {
  const trimmed = guid.trim();
  return trimmed.length > 3 && trimmed !== 'true' && trimmed !== 'false';
}

/** Generate a SHA-256 identity hash from title + publishedAt. */
function hashIdentity(title: string, publishedAt: Date | null): string {
  const input = `${title.toLowerCase().trim()}|${publishedAt?.toISOString() ?? 'no-date'}`;
  return `hash:${createHash('sha256').update(input).digest('hex').slice(0, 16)}`;
}
