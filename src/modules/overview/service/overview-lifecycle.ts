/**
 * Overview Lifecycle — standardised status enum, timestamps, retry logic,
 * scheduler enqueue step, and worker handler.
 *
 * Overview status lives inside EventVersion.packetJson.overview_lifecycle:
 *   {
 *     status: OverviewStatus,
 *     requested_at: ISO | null,
 *     ready_at: ISO | null,
 *     failed_at: ISO | null,
 *     skipped_at: ISO | null,
 *     attempts: number,
 *     fail_reason: string | null,
 *     skip_reason: string | null,
 *   }
 *
 * Backward compatible: if overview_lifecycle is missing → status = NOT_REQUESTED.
 */

import { ulid } from 'ulid';
import type { EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import type { EventBus } from '../../../core/event_bus/index.js';
import type { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import type { VersionRepository } from '../../versions/repo/version-repo.js';
import type { ClaimRepository } from '../../claims/repo/claim-repo.js';
import type { ClaimQuoteExtractor } from '../../claims/service/claim-extractor.js';
import type { OverviewGenerator } from './overview-generator.js';
import { logger } from '../../../core/logging/logger.js';

// ── Status enum ──────────────────────────────────────────────────────

export const OVERVIEW_STATUSES = [
  'NOT_REQUESTED',
  'PENDING',
  'READY',
  'FAILED',
  'SKIPPED',
] as const;

export type OverviewStatus = (typeof OVERVIEW_STATUSES)[number];

// ── Lifecycle payload stored in packetJson.overview_lifecycle ─────────

export interface OverviewLifecycle {
  status: OverviewStatus;
  requested_at: string | null;
  ready_at: string | null;
  failed_at: string | null;
  skipped_at: string | null;
  attempts: number;
  fail_reason: string | null;
  skip_reason: string | null;
}

// ── Config ───────────────────────────────────────────────────────────

export const OVERVIEW_MAX_ATTEMPTS = parseInt(process.env.OVERVIEW_MAX_ATTEMPTS ?? '3', 10);

/** Backoff windows in ms for retry attempts: 30m, 2h, 6h */
export const OVERVIEW_RETRY_BACKOFF_MS: number[] = [
  30 * 60 * 1000,   // 30 minutes
  2 * 60 * 60 * 1000, // 2 hours
  6 * 60 * 60 * 1000, // 6 hours
];

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Read overview_lifecycle from packet_json with backward compatibility.
 * If missing → NOT_REQUESTED with zero attempts.
 */
export function readLifecycle(packet: any): OverviewLifecycle {
  const lc = packet?.overview_lifecycle;
  if (lc && typeof lc === 'object' && typeof lc.status === 'string') {
    return lc as OverviewLifecycle;
  }
  // Backward compat: infer from existing ai_overview
  const ai = packet?.ai_overview;
  if (ai) {
    const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
    const ctx = Array.isArray(ai.context) ? ai.context : [];
    if (wh.length > 0 || ctx.length > 0) {
      return {
        status: 'READY',
        requested_at: null,
        ready_at: null,
        failed_at: null,
        skipped_at: null,
        attempts: 1,
        fail_reason: null,
        skip_reason: null,
      };
    }
  }
  return {
    status: 'NOT_REQUESTED',
    requested_at: null,
    ready_at: null,
    failed_at: null,
    skipped_at: null,
    attempts: 0,
    fail_reason: null,
    skip_reason: null,
  };
}

/**
 * Determine if a FAILED overview is eligible for retry based on
 * attempt count and backoff window.
 */
export function isRetryEligible(lc: OverviewLifecycle, now: Date): boolean {
  if (lc.status !== 'FAILED') return false;
  if (lc.attempts >= OVERVIEW_MAX_ATTEMPTS) return false;
  if (!lc.failed_at) return true; // no timestamp → allow retry
  const failedAt = new Date(lc.failed_at).getTime();
  const backoffIndex = Math.min(lc.attempts - 1, OVERVIEW_RETRY_BACKOFF_MS.length - 1);
  const backoffMs = OVERVIEW_RETRY_BACKOFF_MS[Math.max(0, backoffIndex)];
  return now.getTime() >= failedAt + backoffMs;
}

/**
 * Determine if an overview should be enqueued.
 * True when: NOT_REQUESTED, or FAILED + retry eligible.
 * PENDING, READY, SKIPPED → no enqueue.
 */
export function shouldEnqueue(lc: OverviewLifecycle, now: Date): boolean {
  if (lc.status === 'NOT_REQUESTED') return true;
  if (lc.status === 'FAILED') return isRetryEligible(lc, now);
  return false;
}

// ── C2: Enqueue step (called from scheduler tick) ────────────────────

export interface OverviewEnqueueDeps {
  versionRepo: VersionRepository;
  eventBus: EventBus;
  auditWriter: AuditLogWriter;
}

/**
 * Scan eligible events and enqueue OVERVIEW_REQUESTED for those that need it.
 *
 * Called during the scheduler tick for each published + feed-eligible event.
 * Idempotent: does NOT re-enqueue PENDING or READY events.
 *
 * @param events — array of { event_id, version_id } for published events
 * @param deps   — repositories + event bus
 * @param now    — current time (injectable for testing)
 * @returns number of events enqueued
 */
export async function enqueueOverviews(
  events: Array<{ event_id: string; version_id: string; packetJson: any }>,
  deps: OverviewEnqueueDeps,
  now: Date = new Date(),
): Promise<number> {
  let enqueued = 0;

  for (const ev of events) {
    const lc = readLifecycle(ev.packetJson);

    if (!shouldEnqueue(lc, now)) continue;

    // Transition to PENDING
    const updatedLc: OverviewLifecycle = {
      ...lc,
      status: 'PENDING',
      requested_at: now.toISOString(),
    };
    const updatedPacket = { ...ev.packetJson, overview_lifecycle: updatedLc };

    await deps.versionRepo.update(ev.version_id, { packetJson: updatedPacket });

    await deps.auditWriter.write({
      entity_type: 'EVENT',
      entity_id: ev.event_id,
      action: 'OVERVIEW_REQUESTED',
      trace_id: ulid(),
      data: {
        version_id: ev.version_id,
        attempt: updatedLc.attempts + 1,
        previous_status: lc.status,
      },
    });

    await deps.eventBus.publish({
      event_name: 'OverviewRequested',
      event_id: ulid(),
      occurred_at: now.toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'overview-lifecycle' },
      payload: { event_id: ev.event_id, version_id: ev.version_id },
    });

    enqueued++;
    logger.info({ event_id: ev.event_id, version_id: ev.version_id, attempt: updatedLc.attempts + 1 }, 'overview_enqueued');
  }

  return enqueued;
}

// ── C3: Worker handler (consumes OverviewRequested) ──────────────────

export function createOverviewWorker(
  versionRepo: VersionRepository,
  claimRepo: ClaimRepository,
  claimExtractor: ClaimQuoteExtractor,
  overviewGenerator: OverviewGenerator,
  auditWriter: AuditLogWriter,
): EventHandler {
  return async (envelope: EventEnvelope): Promise<void> => {
    const { event_id, version_id } = envelope.payload as {
      event_id: string;
      version_id: string;
    };
    const traceId = envelope.trace.trace_id;

    try {
      // Read current state
      const version = await versionRepo.findLatestByEventId(event_id);
      if (!version) {
        logger.info({ event_id }, 'overview_worker_no_version');
        return;
      }

      const packet = (version.packetJson as any) ?? {};
      const lc = readLifecycle(packet);

      // Guard: only process PENDING (idempotent — skip if already READY/SKIPPED)
      if (lc.status !== 'PENDING') {
        logger.info({ event_id, status: lc.status }, 'overview_worker_skip_not_pending');
        return;
      }

      // Step 1: claim extraction if needed
      const existingClaims = await claimRepo.countClaimsByVersion(event_id, version.id);
      if (existingClaims === 0) {
        await claimExtractor.handler()({
          event_name: 'EventVersionCommitted',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'overview-worker' },
          payload: { event_id, version_index: version.versionIndex },
        });
      }

      // Step 2: run overview generation
      await overviewGenerator.handler()({
        event_name: 'ClaimGraphBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'overview-worker' },
        payload: { event_id, version_id: version.id },
      });

      // Step 3: read fresh packet to check if overview succeeded
      const freshVersion = await versionRepo.findById(version.id);
      const freshPacket = (freshVersion?.packetJson as any) ?? {};
      const ai = freshPacket.ai_overview;
      const now = new Date();

      // Determine outcome from the overview generation result
      const wh = Array.isArray(ai?.what_happened) ? ai.what_happened : [];
      const ctx = Array.isArray(ai?.context) ? ai.context : [];
      const hasContent = wh.length > 0 || ctx.length > 0;

      // Check if blocked by gates (SKIPPED) vs actually generated (READY)
      const overviewStatus = freshPacket.overview_status;
      const gateStatus = freshVersion?.gateStatus;
      const isGateBlocked = gateStatus === 'FAIL' ||
        overviewStatus?.state === 'blocked' ||
        ai?.status === 'INSUFFICIENT_EVIDENCE';

      let newLc: OverviewLifecycle;

      if (hasContent) {
        // SUCCESS → READY
        newLc = {
          ...lc,
          status: 'READY',
          ready_at: now.toISOString(),
          attempts: lc.attempts + 1,
          fail_reason: null,
        };
        logger.info({ event_id, version_id: version.id }, 'overview_worker_ready');
      } else if (isGateBlocked) {
        // Gate blocked → SKIPPED (won't retry)
        const skipReason = overviewStatus?.reason ?? ai?.status ?? 'gate_blocked';
        newLc = {
          ...lc,
          status: 'SKIPPED',
          skipped_at: now.toISOString(),
          attempts: lc.attempts + 1,
          skip_reason: skipReason,
        };
        logger.info({ event_id, version_id: version.id, skip_reason: skipReason }, 'overview_worker_skipped');
      } else {
        // No content and not gate-blocked → FAILED (can retry)
        newLc = {
          ...lc,
          status: 'FAILED',
          failed_at: now.toISOString(),
          attempts: lc.attempts + 1,
          fail_reason: 'no_content_generated',
        };
        logger.info({ event_id, version_id: version.id, attempts: newLc.attempts }, 'overview_worker_failed');
      }

      // Persist lifecycle update
      freshPacket.overview_lifecycle = newLc;
      freshPacket.ai_run_version_id = version.id;
      await versionRepo.update(version.id, { packetJson: freshPacket });

      // Audit trail
      await auditWriter.write({
        entity_type: 'EVENT',
        entity_id: event_id,
        action: `OVERVIEW_${newLc.status}`,
        trace_id: traceId,
        data: {
          version_id: version.id,
          attempts: newLc.attempts,
          reason: newLc.fail_reason ?? newLc.skip_reason ?? null,
        },
      });

    } catch (err) {
      // Technical error → FAILED
      logger.error(
        { event_id, error: err instanceof Error ? err.message : String(err) },
        'overview_worker_error',
      );

      try {
        const version = await versionRepo.findLatestByEventId(event_id);
        if (version) {
          const packet = (version.packetJson as any) ?? {};
          const lc = readLifecycle(packet);
          const now = new Date();
          const newLc: OverviewLifecycle = {
            ...lc,
            status: 'FAILED',
            failed_at: now.toISOString(),
            attempts: lc.attempts + 1,
            fail_reason: err instanceof Error ? err.message : String(err),
          };
          packet.overview_lifecycle = newLc;
          await versionRepo.update(version.id, { packetJson: packet });

          await auditWriter.write({
            entity_type: 'EVENT',
            entity_id: event_id,
            action: 'OVERVIEW_FAILED',
            trace_id: traceId,
            data: {
              version_id: version.id,
              attempts: newLc.attempts,
              error_code: 'TECHNICAL_ERROR',
              reason: newLc.fail_reason,
            },
          });
        }
      } catch (innerErr) {
        logger.error({ event_id, error: innerErr instanceof Error ? innerErr.message : String(innerErr) }, 'overview_worker_error_recovery_failed');
      }
    }
  };
}
