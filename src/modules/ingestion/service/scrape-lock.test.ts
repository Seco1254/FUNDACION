import { describe, it, expect, beforeEach } from 'vitest';
import { ScrapeLock } from './scrape-lock.js';

describe('ScrapeLock', () => {
  let lock: ScrapeLock;

  beforeEach(() => {
    lock = new ScrapeLock();
  });

  it('acquires and releases', () => {
    expect(lock.tryAcquire('trace-1')).toBe(true);
    expect(lock.getStatus().running).toBe(true);
    expect(lock.getStatus().trace_id).toBe('trace-1');
    lock.release({});
    expect(lock.getStatus().running).toBe(false);
    expect(lock.getStatus().last_finished_at).toBeTruthy();
  });

  it('rejects second acquire while locked', () => {
    expect(lock.tryAcquire('trace-1')).toBe(true);
    expect(lock.tryAcquire('trace-2')).toBe(false);
    lock.release({});
    expect(lock.tryAcquire('trace-3')).toBe(true);
  });

  it('tracks inflight media key', () => {
    lock.tryAcquire('t1');
    lock.setInflightMediaKey('eltiempo');
    expect(lock.getStatus().inflight_media_key).toBe('eltiempo');
    lock.setInflightMediaKey(null);
    expect(lock.getStatus().inflight_media_key).toBeNull();
  });

  it('stores last result summary on success', () => {
    lock.tryAcquire('t1');
    lock.release({ summary: { discovered: 5 } });
    expect(lock.getStatus().last_result_summary).toEqual({ discovered: 5 });
    expect(lock.getStatus().last_error).toBeNull();
  });

  it('stores last error on failure', () => {
    lock.tryAcquire('t1');
    lock.release({ error: 'Timeout' });
    expect(lock.getStatus().last_error).toBe('Timeout');
    expect(lock.getStatus().last_result_summary).toBeNull();
  });

  it('started_at is null before first acquire', () => {
    expect(lock.getStatus().started_at).toBeNull();
    expect(lock.getStatus().running).toBe(false);
  });
});
