/**
 * In-memory LRU + TTL cache.
 * Keys are strings, values are any serializable data.
 * Uses Map insertion order for LRU eviction.
 */

export interface CacheEntry<T = unknown> {
  value: T;
  expiresAt: number; // epoch ms
}

export interface CacheOptions {
  maxEntries: number;
  defaultTtlMs: number;
}

const DEFAULT_OPTIONS: CacheOptions = {
  maxEntries: 500,
  defaultTtlMs: 30_000, // 30s
};

export class Cache {
  private store = new Map<string, CacheEntry>();
  private opts: CacheOptions;

  constructor(opts?: Partial<CacheOptions>) {
    this.opts = { ...DEFAULT_OPTIONS, ...opts };
  }

  get<T = unknown>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;

    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    // Move to end for LRU freshness
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value as T;
  }

  set<T = unknown>(key: string, value: T, ttlMs?: number): void {
    // Delete first to reset position
    this.store.delete(key);

    // Evict oldest if at capacity
    while (this.store.size >= this.opts.maxEntries) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
      else break;
    }

    this.store.set(key, {
      value,
      expiresAt: Date.now() + (ttlMs ?? this.opts.defaultTtlMs),
    });
  }

  del(key: string): boolean {
    return this.store.delete(key);
  }

  delByPrefix(prefix: string): number {
    let count = 0;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        count++;
      }
    }
    return count;
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}
