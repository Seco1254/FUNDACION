import { storage } from './storage';
import type { FeedResponse, EventDetailResponse, BiasEndpointResponse } from './types';

interface CachedItem<T> {
  data: T;
  timestamp: number;
}

const CACHE_KEYS = {
  feed: (cursor?: string) => `cache:feed:${cursor ?? 'first'}`,
  event: (eventId: string) => `cache:event:${eventId}`,
  bias: (eventId: string, mediaKey: string) => `cache:bias:${eventId}:${mediaKey}`,
};

async function getCached<T>(key: string): Promise<CachedItem<T> | null> {
  return storage.get<CachedItem<T>>(key);
}

async function setCached<T>(key: string, data: T): Promise<void> {
  await storage.set(key, { data, timestamp: Date.now() });
}

// ── Public API ──

export const cache = {
  async getFeed(cursor?: string): Promise<CachedItem<FeedResponse> | null> {
    return getCached<FeedResponse>(CACHE_KEYS.feed(cursor));
  },

  async setFeed(data: FeedResponse, cursor?: string): Promise<void> {
    await setCached(CACHE_KEYS.feed(cursor), data);
  },

  async getEvent(eventId: string): Promise<CachedItem<EventDetailResponse> | null> {
    return getCached<EventDetailResponse>(CACHE_KEYS.event(eventId));
  },

  async setEvent(eventId: string, data: EventDetailResponse): Promise<void> {
    await setCached(CACHE_KEYS.event(eventId), data);
  },

  async getBias(eventId: string, mediaKey: string): Promise<CachedItem<BiasEndpointResponse> | null> {
    return getCached<BiasEndpointResponse>(CACHE_KEYS.bias(eventId, mediaKey));
  },

  async setBias(eventId: string, mediaKey: string, data: BiasEndpointResponse): Promise<void> {
    await setCached(CACHE_KEYS.bias(eventId, mediaKey), data);
  },
};

// ── Helpers ──

export function timeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'hace un momento';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours}h`;
  const days = Math.floor(hours / 24);
  return `hace ${days}d`;
}

export function relativeTime(isoString: string | null): string | null {
  if (!isoString) return null;
  try {
    const ts = new Date(isoString).getTime();
    if (isNaN(ts)) return null;
    return timeAgo(ts);
  } catch {
    return null;
  }
}
