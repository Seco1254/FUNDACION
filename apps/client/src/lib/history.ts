import { storage } from './storage';
import type { ViewedEvent } from './types';

const HISTORY_KEY = 'history:viewed';
const MAX_HISTORY = 200;

export const history = {
  async getAll(): Promise<ViewedEvent[]> {
    return (await storage.get<ViewedEvent[]>(HISTORY_KEY)) ?? [];
  },

  async add(event: Omit<ViewedEvent, 'viewed_at'>): Promise<void> {
    const items = await this.getAll();

    // Remove existing entry for this event (dedup)
    const filtered = items.filter((e) => e.event_id !== event.event_id);

    // Prepend new entry
    filtered.unshift({
      ...event,
      viewed_at: new Date().toISOString(),
    });

    // Trim to FIFO max
    const trimmed = filtered.slice(0, MAX_HISTORY);

    await storage.set(HISTORY_KEY, trimmed);
  },

  async clear(): Promise<void> {
    await storage.remove(HISTORY_KEY);
  },
};
