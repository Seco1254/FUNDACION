/**
 * Mega-event prevention guardrails.
 *
 * Prevents events from growing too large (catch-all clusters).
 * Thresholds:
 *   - MAX_ARTICLES_PER_EVENT: 25  (>25 articles = mega-event)
 *   - MAX_SUBEVENTS: 7            (>7 sub-events = mega-event)
 *
 * When an event is flagged as mega:
 *   - New articles are NOT linked to it
 *   - Instead, they create new events
 *   - The mega event is audited
 */

import { logger } from '../../../core/logging/logger.js';
import { metrics } from '../../../core/metrics/metrics.js';

export const MAX_ARTICLES_PER_EVENT = 25;
export const MAX_SUBEVENTS = 7;

export interface MegaEventCheck {
  eventId: string;
  articleCount: number;
  subEventCount: number;
}

export interface MegaEventResult {
  isMega: boolean;
  reason: string | null;
}

/**
 * Check if an event has grown too large to accept new articles.
 */
export function checkMegaEvent(check: MegaEventCheck): MegaEventResult {
  if (check.articleCount > MAX_ARTICLES_PER_EVENT) {
    metrics.incCounter('linking.mega_event_blocked_total');
    logger.info({
      event_id: check.eventId,
      article_count: check.articleCount,
      threshold: MAX_ARTICLES_PER_EVENT,
    }, 'mega_event_article_limit');
    return {
      isMega: true,
      reason: `article_count(${check.articleCount}) > ${MAX_ARTICLES_PER_EVENT}`,
    };
  }

  if (check.subEventCount > MAX_SUBEVENTS) {
    metrics.incCounter('linking.mega_event_blocked_total');
    logger.info({
      event_id: check.eventId,
      sub_event_count: check.subEventCount,
      threshold: MAX_SUBEVENTS,
    }, 'mega_event_subevent_limit');
    return {
      isMega: true,
      reason: `sub_event_count(${check.subEventCount}) > ${MAX_SUBEVENTS}`,
    };
  }

  return { isMega: false, reason: null };
}
