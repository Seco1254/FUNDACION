/**
 * SingleFlight: deduplicates concurrent requests for the same key.
 * If a request for key K is already in-flight, subsequent callers
 * for key K share the same promise instead of triggering a new execution.
 */

export class SingleFlight {
  private inflight = new Map<string, Promise<unknown>>();

  async do<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      this.inflight.delete(key);
    });

    this.inflight.set(key, promise);
    return promise;
  }

  get pending(): number {
    return this.inflight.size;
  }
}
