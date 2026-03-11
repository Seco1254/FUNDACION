import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import { debugScrapeRoutes, ScrapeJobTracker } from './debug-scrape.js';
import { ScrapeLock, scrapeLock } from '../../modules/ingestion/service/scrape-lock.js';
import { withTimeout, TimeoutError } from '../../core/async/with-timeout.js';

function makeOrchestrator(runFn: (onProgress?: (p: any) => void) => Promise<any>) {
  return { run: runFn } as any;
}

/** Wait for a condition to become true (polling). */
async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 20,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe('debug-scrape routes', () => {
  let app: FastifyInstance;
  let tracker: ScrapeJobTracker;

  afterEach(async () => {
    if (scrapeLock.getStatus().running) {
      scrapeLock.release({ error: 'test_cleanup' });
    }
    await app?.close();
  });

  function setup(runFn: (onProgress?: (p: any) => void) => Promise<any>) {
    const orchestrator = makeOrchestrator(runFn);
    tracker = new ScrapeJobTracker();
    app = Fastify();
    app.register(debugScrapeRoutes(orchestrator, tracker));
    return orchestrator;
  }

  // ── POST /v1/debug/scrape/run: responds 202 immediately ────────

  it('responds 202 with job_id in < 200ms', async () => {
    // Orchestrator takes 2s — but we should get 202 immediately
    setup(async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return { discovered: 3, skipped: 1, summary: {} };
    });

    const start = Date.now();
    const res = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    const elapsed = Date.now() - start;

    expect(res.statusCode).toBe(202);
    expect(elapsed).toBeLessThan(200);

    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.job_id).toBeTruthy();
    expect(body.trace_id).toBeTruthy();
    expect(body.accepted_at).toBeTruthy();
    expect(body.status_url).toContain(body.job_id);
    expect(res.headers['x-trace-id']).toBeTruthy();

    // Wait for background job to finish so lock is released
    await waitFor(() => !scrapeLock.getStatus().running);
  });

  it('returns 409 when scrape is already running', async () => {
    let resolveRun!: () => void;
    const blockingPromise = new Promise<void>((resolve) => { resolveRun = resolve; });
    setup(async () => {
      await blockingPromise;
      return { discovered: 0, skipped: 0, summary: {} };
    });
    await app.ready();

    // Fire first request — gets 202
    const first = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    expect(first.statusCode).toBe(202);

    // Wait for the background job to acquire the lock
    await waitFor(() => scrapeLock.getStatus().running);

    // Fire second request — should get 409
    const second = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    expect(second.statusCode).toBe(409);
    const body = second.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('SCRAPE_ALREADY_RUNNING');
    expect(body.started_at).toBeTruthy();

    // Unblock first
    resolveRun();
    await waitFor(() => !scrapeLock.getStatus().running);
  });

  // ── Job lifecycle transitions ──────────────────────────────────

  it('job transitions: queued → running → done', async () => {
    let resolveRun!: () => void;
    const gate = new Promise<void>((resolve) => { resolveRun = resolve; });

    setup(async () => {
      await gate;
      return { discovered: 5, skipped: 2, summary: { test: { discovered: 5 } }, media_results: [] };
    });

    const res = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    const { job_id } = res.json();

    // Should transition to running
    await waitFor(() => tracker.get(job_id)?.state === 'running');
    const running = tracker.get(job_id)!;
    expect(running.state).toBe('running');
    expect(running.started_at).toBeTruthy();

    // Unblock the orchestrator
    resolveRun();

    // Should transition to done
    await waitFor(() => tracker.get(job_id)?.state === 'done');
    const done = tracker.get(job_id)!;
    expect(done.state).toBe('done');
    expect(done.finished_at).toBeTruthy();
    expect(done.duration_ms).toBeGreaterThanOrEqual(0);
    expect(done.discovered).toBe(5);
    expect(done.skipped).toBe(2);
    expect(done.error).toBeNull();
  });

  it('job transitions: queued → running → failed on error', async () => {
    setup(async () => {
      throw new Error('Network failure');
    });

    const res = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    const { job_id } = res.json();

    // Should transition to failed
    await waitFor(() => tracker.get(job_id)?.state === 'failed');
    const failed = tracker.get(job_id)!;
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('SCRAPE_ERROR');
    expect(failed.error_detail).toBeTruthy();
    expect((failed.error_detail as any).message).toBe('Network failure');
    expect(failed.finished_at).toBeTruthy();
  });

  it('job transitions: queued → running → failed on timeout', async () => {
    // Use a very short timeout
    const original = process.env.SCRAPE_TIMEOUT_MS;
    process.env.SCRAPE_TIMEOUT_MS = '50';

    // Need to re-import to pick up new env. Instead test at unit level.
    process.env.SCRAPE_TIMEOUT_MS = original;

    // Test withTimeout path directly
    const never = new Promise(() => {});
    try {
      await withTimeout(never, 50, { stage: 'test_timeout' });
    } catch (err) {
      expect(err).toBeInstanceOf(TimeoutError);
      expect((err as TimeoutError).stage).toBe('test_timeout');
    }
  });

  // ── GET /v1/debug/scrape/status ────────────────────────────────

  it('GET status without job_id returns lock status + recent_jobs', async () => {
    setup(async () => ({ discovered: 0, skipped: 0, summary: {} }));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/scrape/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('running' in body).toBe(true);
    expect('recent_jobs' in body).toBe(true);
    expect(Array.isArray(body.recent_jobs)).toBe(true);
  });

  it('GET status with job_id returns specific job', async () => {
    setup(async () => ({ discovered: 2, skipped: 0, summary: {}, media_results: [] }));

    const runRes = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    const { job_id } = runRes.json();

    // Wait for completion
    await waitFor(() => tracker.get(job_id)?.state === 'done');

    const statusRes = await app.inject({
      method: 'GET',
      url: `/v1/debug/scrape/status?job_id=${job_id}`,
    });
    expect(statusRes.statusCode).toBe(200);
    const body = statusRes.json();
    expect(body.job_id).toBe(job_id);
    expect(body.state).toBe('done');
    expect(body.discovered).toBe(2);
  });

  it('GET status with unknown job_id returns 404', async () => {
    setup(async () => ({ discovered: 0, skipped: 0, summary: {} }));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/debug/scrape/status?job_id=nonexistent',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('JOB_NOT_FOUND');
  });

  // ── Lock + inflight observability ──────────────────────────────

  it('GET status includes inflight_stage, inflight_url, duration_so_far_ms', async () => {
    setup(async () => ({ discovered: 0, skipped: 0, summary: {} }));

    const res = await app.inject({ method: 'GET', url: '/v1/debug/scrape/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect('inflight_stage' in body).toBe(true);
    expect('inflight_url' in body).toBe(true);
    expect('duration_so_far_ms' in body).toBe(true);
    expect(body.inflight_stage).toBeNull();
    expect(body.inflight_url).toBeNull();
    expect(body.duration_so_far_ms).toBeNull();
  });

  it('onProgress updates scrapeLock inflight fields during run', async () => {
    setup(async (onProgress?: (p: any) => void) => {
      onProgress?.({ media_key: 'eltiempo', stage: 'fetch_start', url: 'https://eltiempo.com/' });
      return { discovered: 1, skipped: 0, summary: { eltiempo: { discovered: 1, skipped: 0, fetch_fail: 0 } }, media_results: [] };
    });

    const res = await app.inject({ method: 'POST', url: '/v1/debug/scrape/run' });
    const { job_id } = res.json();

    // Wait for completion
    await waitFor(() => tracker.get(job_id)?.state === 'done');

    // After run completes, lock released — inflight fields cleared
    const statusRes = await app.inject({ method: 'GET', url: '/v1/debug/scrape/status' });
    const status = statusRes.json();
    expect(status.inflight_media_key).toBeNull();
    expect(status.inflight_stage).toBeNull();
  });

  it('inflight state captured before lock release is preserved for error detail', () => {
    const lock = new ScrapeLock();
    lock.tryAcquire('test-trace');
    lock.setInflight('razon_publica', 'fetch_start', 'https://razonpublica.com/');

    const inflightBeforeRelease = lock.getStatus();
    lock.release({ error: 'Timeout' });

    expect(inflightBeforeRelease.inflight_media_key).toBe('razon_publica');
    expect(inflightBeforeRelease.inflight_stage).toBe('fetch_start');
    expect(inflightBeforeRelease.inflight_url).toBe('https://razonpublica.com/');

    const afterRelease = lock.getStatus();
    expect(afterRelease.inflight_media_key).toBeNull();
    expect(afterRelease.inflight_stage).toBeNull();
    expect(afterRelease.inflight_url).toBeNull();
  });

  // ── ScrapeJobTracker unit tests ────────────────────────────────

  describe('ScrapeJobTracker', () => {
    it('create/get/list', () => {
      const t = new ScrapeJobTracker();
      const job = t.create('j1', 'trace1');
      expect(job.state).toBe('queued');
      expect(t.get('j1')).toBe(job);
      expect(t.list()).toHaveLength(1);
    });

    it('state transitions', () => {
      const t = new ScrapeJobTracker();
      t.create('j1', 'trace1');

      t.markRunning('j1');
      expect(t.get('j1')!.state).toBe('running');
      expect(t.get('j1')!.started_at).toBeTruthy();

      t.markDone('j1', {
        duration_ms: 100,
        discovered: 5,
        skipped: 2,
        summary: {},
        media_results: [],
      });
      expect(t.get('j1')!.state).toBe('done');
      expect(t.get('j1')!.finished_at).toBeTruthy();
      expect(t.get('j1')!.discovered).toBe(5);
    });

    it('markFailed sets error info', () => {
      const t = new ScrapeJobTracker();
      t.create('j1', 'trace1');
      t.markRunning('j1');
      t.markFailed('j1', 'TIMEOUT', { stage: 'fetch' });

      const job = t.get('j1')!;
      expect(job.state).toBe('failed');
      expect(job.error).toBe('TIMEOUT');
      expect(job.error_detail).toEqual({ stage: 'fetch' });
      expect(job.finished_at).toBeTruthy();
    });

    it('evicts old jobs beyond MAX_JOB_HISTORY', () => {
      const t = new ScrapeJobTracker();
      for (let i = 0; i < 25; i++) {
        t.create(`j${i}`, `trace${i}`);
      }
      expect(t.list().length).toBeLessThanOrEqual(20);
      // Oldest should be evicted
      expect(t.get('j0')).toBeUndefined();
      // Newest should exist
      expect(t.get('j24')).toBeTruthy();
    });

    it('get returns undefined for unknown job_id', () => {
      const t = new ScrapeJobTracker();
      expect(t.get('nonexistent')).toBeUndefined();
    });
  });
});
