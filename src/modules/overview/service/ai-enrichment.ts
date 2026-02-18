import { ulid } from 'ulid';
import type { EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import type { ClaimQuoteExtractor } from '../../claims/service/claim-extractor.js';
import type { OverviewGenerator } from './overview-generator.js';
import type { VersionRepository } from '../../versions/repo/version-repo.js';
import type { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { logger } from '../../../core/logging/logger.js';

/**
 * Auto-run handler: subscribes to EventPublished and triggers the
 * AI enrichment pipeline (claims + dispute + overview) for the
 * latest event_version if it hasn't already run.
 *
 * - Idempotent: checks packet_json.ai_run_version_id
 * - Best-effort: errors are logged, never propagated
 */
export function createPublishedHandler(
  versionRepo: VersionRepository,
  claimRepo: ClaimRepository,
  claimExtractor: ClaimQuoteExtractor,
  overviewGenerator: OverviewGenerator,
): EventHandler {
  return async (envelope: EventEnvelope): Promise<void> => {
    const { event_id } = envelope.payload as { event_id: string };
    const traceId = envelope.trace.trace_id;

    try {
      const version = await versionRepo.findLatestByEventId(event_id);
      if (!version) {
        logger.info({ event_id }, 'ai_enrichment_no_version');
        return;
      }

      const packet = (version.packetJson as any) ?? {};

      // Idempotent: skip if AI already enriched this exact version
      if (packet.ai_run_version_id === version.id) {
        logger.info({ event_id, version_id: version.id }, 'ai_enrichment_already_ran');
        return;
      }

      // Step 1: Run claim extraction if no claims exist for this version
      const existingClaims = await claimRepo.countClaimsByVersion(event_id, version.id);
      if (existingClaims === 0) {
        await claimExtractor.handler()({
          event_name: 'EventVersionCommitted',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'ai-enrichment' },
          payload: { event_id, version_index: version.versionIndex },
        });
      }

      // Step 2: Run overview generation (includes dispute detection + AI overview)
      await overviewGenerator.handler()({
        event_name: 'ClaimGraphBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'ai-enrichment' },
        payload: { event_id, version_id: version.id },
      });

      // Mark this version as AI-enriched (read fresh after overview update)
      const freshVersion = await versionRepo.findById(version.id);
      const freshPacket = (freshVersion?.packetJson as any) ?? {};
      freshPacket.ai_run_version_id = version.id;
      await versionRepo.update(version.id, { packetJson: freshPacket });

      logger.info({ event_id, version_id: version.id }, 'ai_enrichment_completed');
    } catch (err) {
      // Best-effort: never propagate errors from AI enrichment
      logger.error(
        { event_id, error: err instanceof Error ? err.message : String(err) },
        'ai_enrichment_failed',
      );
    }
  };
}
