import { describe, it, expect, vi } from 'vitest';
import { SingleFlight } from './singleflight.js';

describe('SingleFlight', () => {
  it('deduplicates concurrent calls for the same key', async () => {
    const sf = new SingleFlight();
    let callCount = 0;

    const fn = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return 'result';
    };

    // Fire 3 concurrent requests for the same key
    const [r1, r2, r3] = await Promise.all([
      sf.do('key1', fn),
      sf.do('key1', fn),
      sf.do('key1', fn),
    ]);

    expect(r1).toBe('result');
    expect(r2).toBe('result');
    expect(r3).toBe('result');
    expect(callCount).toBe(1); // Only executed once
  });

  it('allows different keys to execute independently', async () => {
    const sf = new SingleFlight();
    let callCount = 0;

    const fn = async () => {
      callCount++;
      return callCount;
    };

    const [r1, r2] = await Promise.all([
      sf.do('key1', fn),
      sf.do('key2', fn),
    ]);

    expect(callCount).toBe(2);
    expect(r1).not.toBe(r2);
  });

  it('clears inflight after completion', async () => {
    const sf = new SingleFlight();
    await sf.do('key1', async () => 'done');
    expect(sf.pending).toBe(0);

    // Second call should execute fresh
    let called = false;
    await sf.do('key1', async () => {
      called = true;
      return 'again';
    });
    expect(called).toBe(true);
  });

  it('propagates errors to all waiters', async () => {
    const sf = new SingleFlight();

    const fn = async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw new Error('boom');
    };

    const results = await Promise.allSettled([
      sf.do('key1', fn),
      sf.do('key1', fn),
    ]);

    expect(results[0].status).toBe('rejected');
    expect(results[1].status).toBe('rejected');
  });
});
