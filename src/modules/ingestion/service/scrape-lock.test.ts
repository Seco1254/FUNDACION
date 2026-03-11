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

  it('setInflight updates mediaKey, stage, and url atomically', () => {
    lock.tryAcquire('t1');
    lock.setInflight('elespectador', 'fetch_start', 'https://www.elespectador.com/');
    const status = lock.getStatus();
    expect(status.inflight_media_key).toBe('elespectador');
    expect(status.inflight_stage).toBe('fetch_start');
    expect(status.inflight_url).toBe('https://www.elespectador.com/');
  });

  it('setInflight with null url sets inflight_url to null', () => {
    lock.tryAcquire('t1');
    lock.setInflight('razon_publica', 'media_run_start');
    const status = lock.getStatus();
    expect(status.inflight_media_key).toBe('razon_publica');
    expect(status.inflight_stage).toBe('media_run_start');
    expect(status.inflight_url).toBeNull();
  });

  it('release clears inflight_stage and inflight_url', () => {
    lock.tryAcquire('t1');
    lock.setInflight('eltiempo', 'fetch_start', 'https://eltiempo.com/');
    lock.release({});
    const status = lock.getStatus();
    expect(status.inflight_media_key).toBeNull();
    expect(status.inflight_stage).toBeNull();
    expect(status.inflight_url).toBeNull();
  });

  it('duration_so_far_ms is null when not running', () => {
    expect(lock.getStatus().duration_so_far_ms).toBeNull();
  });

  it('duration_so_far_ms is a number >= 0 while running', async () => {
    lock.tryAcquire('t1');
    await new Promise((r) => setTimeout(r, 10));
    const status = lock.getStatus();
    expect(status.duration_so_far_ms).not.toBeNull();
    expect(status.duration_so_far_ms).toBeGreaterThanOrEqual(0);
    lock.release({});
    expect(lock.getStatus().duration_so_far_ms).toBeNull();
  });

  it('inflight_stage is null before first acquire', () => {
    expect(lock.getStatus().inflight_stage).toBeNull();
    expect(lock.getStatus().inflight_url).toBeNull();
  });
});
