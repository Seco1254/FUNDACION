import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { ulid } from 'ulid';
import { EventRepository } from '../../modules/events/repo/event-repo.js';
import { ClaimRepository } from '../../modules/claims/repo/claim-repo.js';
import { VersionRepository } from '../../modules/versions/repo/version-repo.js';
import { MediaRepository } from '../../modules/media/repo/media-repo.js';
import { EventBus } from '../../core/event_bus/dispatcher.js';
import type { AuditLogWriter } from '../../core/event_bus/dispatcher.js';
import { ClaimQuoteExtractor } from '../../modules/claims/service/claim-extractor.js';
import { OverviewGenerator } from '../../modules/overview/service/overview-generator.js';
import type { LlmClient } from '../../core/llm/client.js';

export function debugAiRoutes(
  eventRepo: EventRepository,
  claimRepo: ClaimRepository,
  versionRepo: VersionRepository,
  mediaRepo: MediaRepository,
  eventBus: EventBus,
  auditWriter: AuditLogWriter,
  llm: LlmClient | null,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    /**
     * POST /v1/debug/ai/run?event_id=...
     *
     * Manually trigger the LLM-powered claim extraction + overview pipeline
     * for a given event. Useful for debugging and testing.
     */
    app.post<{ Querystring: { event_id: string } }>(
      '/v1/debug/ai/run',
      async (request, reply) => {
        const eventId = (request.query as any).event_id;
        if (!eventId) {
          return reply.status(400).send({ error: 'event_id query parameter required' });
        }

        // Validate event exists
        const event = await eventRepo.findById(eventId);
        if (!event) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        // Find latest version
        const version = await versionRepo.findLatestByEventId(eventId);
        if (!version) {
          return reply.status(404).send({ error: 'No version found for event' });
        }

        const traceId = ulid();
        const results: Record<string, unknown> = {
          event_id: eventId,
          version_id: version.id,
          llm_available: llm?.isAvailable() ?? false,
        };

        // Step 1: Run claim extraction
        const extractor = new ClaimQuoteExtractor(
          eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter, llm,
        );

        // Clear existing claims for re-run
        await claimRepo.deleteClaimsByVersion(eventId, version.id);

        const extractorEnvelope = {
          event_name: 'EventVersionCommitted',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'debug-ai' },
          payload: { event_id: eventId, version_index: version.versionIndex },
        };

        await extractor.handler()(extractorEnvelope);

        const claimsCount = await claimRepo.countClaimsByVersion(eventId, version.id);
        results.claims_extracted = claimsCount;

        // Step 2: Run overview generation
        const generator = new OverviewGenerator(
          claimRepo, versionRepo, eventBus, auditWriter, llm,
        );

        const overviewEnvelope = {
          event_name: 'ClaimGraphBuilt',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'debug-ai' },
          payload: { event_id: eventId, version_id: version.id },
        };

        await generator.handler()(overviewEnvelope);

        // Read back the updated version
        const updatedVersion = await versionRepo.findById(version.id);
        const packet = (updatedVersion?.packetJson as any) ?? {};

        results.overview = packet.overview ?? null;
        results.ai_overview = packet.ai_overview ?? null;
        results.overview_mode = packet.overview_mode ?? 'heuristic';
        results.quality_flags = packet.quality_flags ?? null;

        return reply.send({ ok: true, ...results });
      },
    );

    done();
  };
}
