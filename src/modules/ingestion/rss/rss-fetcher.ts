/**
 * RSS Fetcher — fetches raw XML from an RSS feed URL.
 *
 * Isolated from parsing so each concern is independently testable.
 * Uses native fetch with timeout and User-Agent.
 */

import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';

const RSS_FETCH_TIMEOUT_MS = parseInt(process.env.RSS_FETCH_TIMEOUT_MS ?? '15000', 10);
const RSS_USER_AGENT = 'FUNDACION-RSS/1.0 (+https://github.com/Seco1254/FUNDACION)';

export interface RssFetchResult {
  xml: string;
  latencyMs: number;
}

export async function fetchRssFeed(feedUrl: string): Promise<RssFetchResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(feedUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': RSS_USER_AGENT },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${feedUrl}`);
    }

    const xml = await response.text();
    const latencyMs = Date.now() - start;

    metrics.incCounter('rss.fetch_total');
    logger.info({ feed_url: feedUrl, latency_ms: latencyMs, bytes: xml.length }, 'rss_fetch_ok');

    return { xml, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    metrics.incCounter('rss.fetch_error_total');

    const error = err instanceof Error ? err : new Error(String(err));
    const isTimeout = error.name === 'AbortError';

    logger.error({
      feed_url: feedUrl,
      latency_ms: latencyMs,
      error: error.message,
      timeout: isTimeout,
    }, 'rss_fetch_error');

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
