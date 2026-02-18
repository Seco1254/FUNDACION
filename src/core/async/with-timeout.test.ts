import { describe, it, expect } from 'vitest';
import { withTimeout, TimeoutError } from './with-timeout.js';

describe('withTimeout', () => {
  it('resolves if promise completes before timeout', async () => {
    const result = await withTimeout(Promise.resolve(42), 1000, { stage: 'test' });
    expect(result).toBe(42);
  });

  it('rejects with TimeoutError if promise exceeds timeout', async () => {
    const never = new Promise<void>(() => {}); // never resolves
    await expect(
      withTimeout(never, 50, { stage: 'slow_fetch', mediaKey: 'test_media' }),
    ).rejects.toThrow(TimeoutError);

    try {
      await withTimeout(never, 50, { stage: 'slow_fetch', mediaKey: 'test_media' });
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      const te = err as TimeoutError;
      expect(te.stage).toBe('slow_fetch');
      expect(te.mediaKey).toBe('test_media');
      expect(te.timeoutMs).toBe(50);
      expect(te.message).toContain('50ms');
      expect(te.message).toContain('slow_fetch');
    }
  });

  it('propagates original error if promise rejects before timeout', async () => {
    const failing = Promise.reject(new Error('original'));
    await expect(
      withTimeout(failing, 5000, { stage: 'test' }),
    ).rejects.toThrow('original');
  });

  it('works without mediaKey', async () => {
    const never = new Promise<void>(() => {});
    try {
      await withTimeout(never, 30, { stage: 'no_media' });
    } catch (err) {
      const te = err as TimeoutError;
      expect(te.mediaKey).toBeNull();
    }
  });
});
