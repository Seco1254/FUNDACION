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
     * POST /v1/debug/ai/run?event_id=...&force=1
     *
     * Manually trigger the LLM-powered claim extraction + overview pipeline.
     * force=1: ignore dedupe hashes, clear AI fields, re-generate everything.
     */
    app.post<{ Querystring: { event_id: string; force?: string } }>(
      '/v1/debug/ai/run',
      async (request, reply) => {
        const eventId = (request.query as any).event_id;
        if (!eventId) {
          return reply.status(400).send({ error: 'event_id query parameter required' });
        }

        const force = (request.query as any).force === '1';

        const event = await eventRepo.findById(eventId);
        if (!event) {
          return reply.status(404).send({ error: 'Event not found' });
        }

        const version = await versionRepo.findLatestByEventId(eventId);
        if (!version) {
          return reply.status(404).send({ error: 'No version found for event' });
        }

        const traceId = ulid();
        const results: Record<string, unknown> = {
          event_id: eventId,
          version_id: version.id,
          llm_available: llm?.isAvailable() ?? false,
          force,
        };

        if (force) {
          // Selective cleanup: delete claims, clear AI-specific packet_json fields
          await claimRepo.deleteClaimsByVersion(eventId, version.id);

          const packet = (version.packetJson as any) ?? {};
          delete packet.ai_overview;
          delete packet.ai_teaser;
          delete packet.overview_mode;
          delete packet._ai_hashes;
          delete packet.ai_run_version_id;
          await versionRepo.update(version.id, { packetJson: packet });

          results.cleanup = 'claims_deleted_ai_fields_cleared';
        }

        // Step 1: Run claim extraction
        const extractor = new ClaimQuoteExtractor(
          eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter, llm,
        );

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
          claimRepo, versionRepo, eventBus, auditWriter, llm, eventRepo,
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

        // Gather article diagnostics
        const articles = await eventRepo.findArticlesForEvent(eventId);
        const uniqueMediaKeys = new Set(articles.map((a: any) => a.media?.mediaKey ?? 'unknown'));

        const supportedClaims = await claimRepo.findClaimsWithQuotesByVersion(eventId, version.id);
        const supportedCount = supportedClaims.filter((c: any) => c.status === 'SUPPORTED').length;

        const aiOverview = packet.ai_overview ?? {};
        const sectionsFilled = ['what_happened', 'context', 'in_dispute']
          .filter((k) => Array.isArray(aiOverview[k]) && aiOverview[k].length > 0).length;

        results.article_count = articles.length;
        results.unique_media_count = uniqueMediaKeys.size;
        results.per_article = articles.map((a: any) => ({
          url: a.url,
          media_key: a.media?.mediaKey ?? 'unknown',
          status: a.status,
          text_len: (a.textNorm ?? '').length,
        }));
        results.gate_status = packet.overview?.gate_status ?? 'NA';
        results.supported_claims_count = supportedCount;
        results.overview = packet.overview ?? null;
        results.ai_overview = packet.ai_overview ?? null;
        results.ai_teaser = packet.ai_teaser ?? null;
        results.overview_mode = packet.overview_mode ?? 'heuristic';
        results.confidence_label = aiOverview.confidence_label ?? null;
        results.sections_filled_count = sectionsFilled;
        results.facts_extracted_count = Array.isArray(aiOverview._audit?.facts_extracted)
          ? aiOverview._audit.facts_extracted.length : 0;
        results.quality_flags = packet.quality_flags ?? null;
        results._ai_hashes = packet._ai_hashes ?? null;

        return reply.send({ ok: true, ...results });
      },
    );

    done();
  };
}
