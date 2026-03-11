import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readLifecycle,
  isRetryEligible,
  shouldEnqueue,
  enqueueOverviews,
  OVERVIEW_MAX_ATTEMPTS,
  OVERVIEW_RETRY_BACKOFF_MS,
  type OverviewLifecycle,
  type OverviewEnqueueDeps,
} from './overview-lifecycle.js';

// ── readLifecycle ──────────────────────────────────────────────────

describe('readLifecycle', () => {
  it('returns NOT_REQUESTED for null packet', () => {
    expect(readLifecycle(null).status).toBe('NOT_REQUESTED');
  });

  it('returns NOT_REQUESTED for empty packet', () => {
    expect(readLifecycle({}).status).toBe('NOT_REQUESTED');
  });

  it('returns NOT_REQUESTED for packet without overview_lifecycle', () => {
    expect(readLifecycle({ some_field: 123 }).status).toBe('NOT_REQUESTED');
  });

  it('returns stored lifecycle when present', () => {
    const lc: OverviewLifecycle = {
      status: 'PENDING',
      requested_at: '2025-01-01T00:00:00Z',
      ready_at: null,
      failed_at: null,
      skipped_at: null,
      attempts: 1,
      fail_reason: null,
      skip_reason: null,
    };
    const result = readLifecycle({ overview_lifecycle: lc });
    expect(result.status).toBe('PENDING');
    expect(result.requested_at).toBe('2025-01-01T00:00:00Z');
  });

  it('backward compat: infers READY from existing ai_overview with content', () => {
    const packet = {
      ai_overview: { what_happened: ['Something happened'], context: [] },
    };
    const result = readLifecycle(packet);
    expect(result.status).toBe('READY');
    expect(result.attempts).toBe(1);
  });

  it('backward compat: NOT_REQUESTED when ai_overview has empty arrays', () => {
    const packet = {
      ai_overview: { what_happened: [], context: [] },
    };
    expect(readLifecycle(packet).status).toBe('NOT_REQUESTED');
  });

  it('backward compat: READY when only context has content', () => {
    const packet = {
      ai_overview: { what_happened: [], context: ['Some context'] },
    };
    expect(readLifecycle(packet).status).toBe('READY');
  });

  it('prefers explicit overview_lifecycle over ai_overview inference', () => {
    const packet = {
      overview_lifecycle: {
        status: 'FAILED',
        requested_at: null,
        ready_at: null,
        failed_at: '2025-01-01T00:00:00Z',
        skipped_at: null,
        attempts: 2,
        fail_reason: 'technical_error',
        skip_reason: null,
      },
      ai_overview: { what_happened: ['Content exists'], context: [] },
    };
    expect(readLifecycle(packet).status).toBe('FAILED');
  });
});

// ── isRetryEligible ────────────────────────────────────────────────

describe('isRetryEligible', () => {
  const baseFailed: OverviewLifecycle = {
    status: 'FAILED',
    requested_at: '2025-01-01T00:00:00Z',
    ready_at: null,
    failed_at: '2025-01-01T01:00:00Z',
    skipped_at: null,
    attempts: 1,
    fail_reason: 'no_content',
    skip_reason: null,
  };

  it('returns false for non-FAILED status', () => {
    expect(isRetryEligible({ ...baseFailed, status: 'READY' }, new Date())).toBe(false);
    expect(isRetryEligible({ ...baseFailed, status: 'PENDING' }, new Date())).toBe(false);
    expect(isRetryEligible({ ...baseFailed, status: 'SKIPPED' }, new Date())).toBe(false);
    expect(isRetryEligible({ ...baseFailed, status: 'NOT_REQUESTED' }, new Date())).toBe(false);
  });

  it('returns false when attempts >= max', () => {
    const maxed = { ...baseFailed, attempts: OVERVIEW_MAX_ATTEMPTS };
    expect(isRetryEligible(maxed, new Date('2030-01-01'))).toBe(false);
  });

  it('returns true when no failed_at timestamp', () => {
    const noTs = { ...baseFailed, failed_at: null };
    expect(isRetryEligible(noTs, new Date())).toBe(true);
  });

  it('returns false when within backoff window (attempt 1 → 30m)', () => {
    const failedAt = new Date('2025-01-01T01:00:00Z');
    const tooSoon = new Date(failedAt.getTime() + 10 * 60 * 1000); // +10 min
    expect(isRetryEligible(baseFailed, tooSoon)).toBe(false);
  });

  it('returns true when past backoff window (attempt 1 → 30m)', () => {
    const failedAt = new Date('2025-01-01T01:00:00Z');
    const afterBackoff = new Date(failedAt.getTime() + 31 * 60 * 1000); // +31 min
    expect(isRetryEligible(baseFailed, afterBackoff)).toBe(true);
  });

  it('uses 2h backoff for second attempt', () => {
    const lc = { ...baseFailed, attempts: 2, failed_at: '2025-01-01T01:00:00Z' };
    const failedAt = new Date('2025-01-01T01:00:00Z');
    const tooSoon = new Date(failedAt.getTime() + 60 * 60 * 1000); // +1h
    const afterBackoff = new Date(failedAt.getTime() + 2 * 60 * 60 * 1000 + 1000); // +2h 1s
    expect(isRetryEligible(lc, tooSoon)).toBe(false);
    expect(isRetryEligible(lc, afterBackoff)).toBe(true);
  });

  it('uses 6h backoff for third+ attempt', () => {
    const lc = { ...baseFailed, attempts: 2, failed_at: '2025-01-01T01:00:00Z' };
    const failedAt = new Date('2025-01-01T01:00:00Z');
    // attempts=2 → backoff index = 1 (2h window)
    const tooSoon = new Date(failedAt.getTime() + 1.5 * 60 * 60 * 1000); // +1.5h
    expect(isRetryEligible(lc, tooSoon)).toBe(false);
  });

  it('backoff index clamps to max array index', () => {
    // attempts=10 (way past max, but check clamping doesn't crash)
    const lc = { ...baseFailed, attempts: 2, failed_at: '2025-01-01T01:00:00Z' };
    // Even with high attempts, should not crash
    expect(() => isRetryEligible(lc, new Date('2030-01-01'))).not.toThrow();
  });
});

// ── shouldEnqueue ──────────────────────────────────────────────────

describe('shouldEnqueue', () => {
  const now = new Date('2025-06-01T12:00:00Z');

  it('returns true for NOT_REQUESTED', () => {
    const lc = readLifecycle({});
    expect(shouldEnqueue(lc, now)).toBe(true);
  });

  it('returns false for PENDING', () => {
    const lc: OverviewLifecycle = {
      status: 'PENDING', requested_at: now.toISOString(),
      ready_at: null, failed_at: null, skipped_at: null,
      attempts: 0, fail_reason: null, skip_reason: null,
    };
    expect(shouldEnqueue(lc, now)).toBe(false);
  });

  it('returns false for READY', () => {
    const lc: OverviewLifecycle = {
      status: 'READY', requested_at: null, ready_at: now.toISOString(),
      failed_at: null, skipped_at: null, attempts: 1,
      fail_reason: null, skip_reason: null,
    };
    expect(shouldEnqueue(lc, now)).toBe(false);
  });

  it('returns false for SKIPPED', () => {
    const lc: OverviewLifecycle = {
      status: 'SKIPPED', requested_at: null, ready_at: null,
      failed_at: null, skipped_at: now.toISOString(), attempts: 1,
      fail_reason: null, skip_reason: 'gate_blocked',
    };
    expect(shouldEnqueue(lc, now)).toBe(false);
  });

  it('returns true for FAILED with retry eligible', () => {
    const failedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2h ago
    const lc: OverviewLifecycle = {
      status: 'FAILED', requested_at: null, ready_at: null,
      failed_at: failedAt.toISOString(), skipped_at: null, attempts: 1,
      fail_reason: 'no_content', skip_reason: null,
    };
    expect(shouldEnqueue(lc, now)).toBe(true);
  });

  it('returns false for FAILED at max attempts', () => {
    const lc: OverviewLifecycle = {
      status: 'FAILED', requested_at: null, ready_at: null,
      failed_at: '2025-01-01T00:00:00Z', skipped_at: null,
      attempts: OVERVIEW_MAX_ATTEMPTS,
      fail_reason: 'no_content', skip_reason: null,
    };
    expect(shouldEnqueue(lc, now)).toBe(false);
  });

  it('returns false for FAILED within backoff window', () => {
    const failedAt = new Date(now.getTime() - 10 * 60 * 1000); // 10 min ago (< 30m backoff)
    const lc: OverviewLifecycle = {
      status: 'FAILED', requested_at: null, ready_at: null,
      failed_at: failedAt.toISOString(), skipped_at: null, attempts: 1,
      fail_reason: 'no_content', skip_reason: null,
    };
    expect(shouldEnqueue(lc, now)).toBe(false);
  });
});

// ── enqueueOverviews ──────────────────────────────────────────────

describe('enqueueOverviews', () => {
  let mockDeps: OverviewEnqueueDeps;

  beforeEach(() => {
    mockDeps = {
      versionRepo: {
        update: vi.fn().mockResolvedValue({}),
        findLatestByEventId: vi.fn(),
        findById: vi.fn(),
        create: vi.fn(),
      } as any,
      eventBus: {
        publish: vi.fn().mockResolvedValue(undefined),
        subscribe: vi.fn(),
      } as any,
      auditWriter: {
        write: vi.fn().mockResolvedValue(undefined),
      } as any,
    };
  });

  it('enqueues NOT_REQUESTED events', async () => {
    const events = [{ event_id: 'evt-1', version_id: 'ver-1', packetJson: {} }];
    const count = await enqueueOverviews(events, mockDeps);
    expect(count).toBe(1);
    expect(mockDeps.versionRepo.update).toHaveBeenCalledTimes(1);
    expect(mockDeps.eventBus.publish).toHaveBeenCalledTimes(1);
    expect(mockDeps.auditWriter.write).toHaveBeenCalledTimes(1);
  });

  it('skips READY events (idempotent)', async () => {
    const events = [{
      event_id: 'evt-1', version_id: 'ver-1',
      packetJson: {
        overview_lifecycle: {
          status: 'READY', requested_at: null, ready_at: '2025-01-01',
          failed_at: null, skipped_at: null, attempts: 1,
          fail_reason: null, skip_reason: null,
        },
      },
    }];
    const count = await enqueueOverviews(events, mockDeps);
    expect(count).toBe(0);
    expect(mockDeps.versionRepo.update).not.toHaveBeenCalled();
  });

  it('skips PENDING events (idempotent)', async () => {
    const events = [{
      event_id: 'evt-1', version_id: 'ver-1',
      packetJson: {
        overview_lifecycle: {
          status: 'PENDING', requested_at: '2025-01-01',
          ready_at: null, failed_at: null, skipped_at: null,
          attempts: 0, fail_reason: null, skip_reason: null,
        },
      },
    }];
    const count = await enqueueOverviews(events, mockDeps);
    expect(count).toBe(0);
  });

  it('skips SKIPPED events', async () => {
    const events = [{
      event_id: 'evt-1', version_id: 'ver-1',
      packetJson: {
        overview_lifecycle: {
          status: 'SKIPPED', requested_at: null, ready_at: null,
          failed_at: null, skipped_at: '2025-01-01', attempts: 1,
          fail_reason: null, skip_reason: 'coherence_gate_failed',
        },
      },
    }];
    const count = await enqueueOverviews(events, mockDeps);
    expect(count).toBe(0);
  });

  it('enqueues FAILED events past backoff', async () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const failedAt = new Date(now.getTime() - 60 * 60 * 1000); // 1h ago
    const events = [{
      event_id: 'evt-1', version_id: 'ver-1',
      packetJson: {
        overview_lifecycle: {
          status: 'FAILED', requested_at: null, ready_at: null,
          failed_at: failedAt.toISOString(), skipped_at: null,
          attempts: 1, fail_reason: 'no_content', skip_reason: null,
        },
      },
    }];
    const count = await enqueueOverviews(events, mockDeps, now);
    expect(count).toBe(1);
  });

  it('does not enqueue FAILED events within backoff', async () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const failedAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 min ago
    const events = [{
      event_id: 'evt-1', version_id: 'ver-1',
      packetJson: {
        overview_lifecycle: {
          status: 'FAILED', requested_at: null, ready_at: null,
          failed_at: failedAt.toISOString(), skipped_at: null,
          attempts: 1, fail_reason: 'no_content', skip_reason: null,
        },
      },
    }];
    const count = await enqueueOverviews(events, mockDeps, now);
    expect(count).toBe(0);
  });

  it('sets status to PENDING and requested_at on enqueue', async () => {
    const now = new Date('2025-06-01T12:00:00Z');
    const events = [{ event_id: 'evt-1', version_id: 'ver-1', packetJson: {} }];
    await enqueueOverviews(events, mockDeps, now);

    const updateCall = (mockDeps.versionRepo.update as any).mock.calls[0];
    const updatedPacket = updateCall[1].packetJson;
    expect(updatedPacket.overview_lifecycle.status).toBe('PENDING');
    expect(updatedPacket.overview_lifecycle.requested_at).toBe(now.toISOString());
  });

  it('publishes OVERVIEW_REQUESTED event on enqueue', async () => {
    const events = [{ event_id: 'evt-1', version_id: 'ver-1', packetJson: {} }];
    await enqueueOverviews(events, mockDeps);

    const publishCall = (mockDeps.eventBus.publish as any).mock.calls[0];
    expect(publishCall[0].event_name).toBe('OverviewRequested');
    expect(publishCall[0].payload.event_id).toBe('evt-1');
    expect(publishCall[0].payload.version_id).toBe('ver-1');
  });

  it('writes OVERVIEW_REQUESTED audit log', async () => {
    const events = [{ event_id: 'evt-1', version_id: 'ver-1', packetJson: {} }];
    await enqueueOverviews(events, mockDeps);

    const auditCall = (mockDeps.auditWriter.write as any).mock.calls[0][0];
    expect(auditCall.action).toBe('OVERVIEW_REQUESTED');
    expect(auditCall.entity_id).toBe('evt-1');
  });

  it('handles mixed batch: enqueues eligible, skips ready', async () => {
    const events = [
      { event_id: 'evt-1', version_id: 'ver-1', packetJson: {} },
      {
        event_id: 'evt-2', version_id: 'ver-2',
        packetJson: {
          overview_lifecycle: {
            status: 'READY', requested_at: null, ready_at: '2025-01-01',
            failed_at: null, skipped_at: null, attempts: 1,
            fail_reason: null, skip_reason: null,
          },
        },
      },
      { event_id: 'evt-3', version_id: 'ver-3', packetJson: {} },
    ];
    const count = await enqueueOverviews(events, mockDeps);
    expect(count).toBe(2);
    expect(mockDeps.versionRepo.update).toHaveBeenCalledTimes(2);
  });
});
