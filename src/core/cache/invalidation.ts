/**
 * Cache invalidation via event bus.
 * Subscribes to pipeline events and clears relevant cache entries.
 */

import { EventEnvelope } from '../event_bus/envelope.js';
import { EventBus } from '../event_bus/dispatcher.js';
import { Cache } from './cache.js';

export function registerCacheInvalidation(eventBus: EventBus, cache: Cache): void {
  // When a new version is committed, invalidate that event's detail cache and feed cache
  eventBus.subscribe('EventVersionCommitted', 'Cache.invalidateVersion', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    const eventId = payload.event_id as string;
    if (eventId) {
      cache.del(`event:${eventId}`);
    }
    // Invalidate all feed caches since ordering may change
    cache.delByPrefix('feed:');
  });

  // When bias labels are built, invalidate event detail cache
  eventBus.subscribe('BiasLabelsBuilt', 'Cache.invalidateBias', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    const eventId = payload.event_id as string;
    if (eventId) {
      cache.del(`event:${eventId}`);
      cache.delByPrefix(`bias:${eventId}:`);
    }
  });

  // When subevents are built, invalidate event detail cache
  eventBus.subscribe('SubEventsBuilt', 'Cache.invalidateSubEvents', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    const eventId = payload.event_id as string;
    if (eventId) {
      cache.del(`event:${eventId}`);
    }
  });
}
