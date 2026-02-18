import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { TopicAssignmentRepository } from '../../topics/repo/topic-assignment-repo.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { logger } from '../../../core/logging/logger.js';
import type { HeatmapBin } from '../../topics/domain/types.js';

export interface SubEvent {
  sub_event_id: string;
  label: string;
  predicate_summary: string;
  article_ids: string[];
  key_claim_ids: string[];
}

const DRIFT_CONSECUTIVE_BINS = 3;
const CLAIM_DIVERGENCE_MIN = 3;

export function detectTopicDrift(heatmap: HeatmapBin[]): { driftTopic: string; startBin: number } | null {
  // Find first bin with any activity to identify initial dominant topic
  let initialTopic: string | null = null;
  for (const bin of heatmap) {
    const entries = Object.entries(bin.topics);
    if (entries.length === 0) continue;
    entries.sort((a, b) => b[1] - a[1]);
    initialTopic = entries[0][0];
    break;
  }
  if (!initialTopic) return null;

  // Look for a different topic that becomes dominant for >= DRIFT_CONSECUTIVE_BINS consecutive bins
  let currentDriftTopic: string | null = null;
  let consecutiveCount = 0;
  let startBin = 0;

  for (const bin of heatmap) {
    const entries = Object.entries(bin.topics);
    if (entries.length === 0) {
      consecutiveCount = 0;
      currentDriftTopic = null;
      continue;
    }
    entries.sort((a, b) => b[1] - a[1]);
    const dominant = entries[0][0];

    if (dominant !== initialTopic) {
      if (dominant === currentDriftTopic) {
        consecutiveCount++;
      } else {
        currentDriftTopic = dominant;
        consecutiveCount = 1;
        startBin = bin.bin_index;
      }

      if (consecutiveCount >= DRIFT_CONSECUTIVE_BINS) {
        return { driftTopic: currentDriftTopic!, startBin };
      }
    } else {
      consecutiveCount = 0;
      currentDriftTopic = null;
    }
  }

  return null;
}

export function detectClaimDivergence(
  claims: any[],
  existingSubEventClaimIds: Set<string>,
): { label: string; claimIds: string[] } | null {
  // Group claims by shared top tokens
  const claimTokens = claims
    .filter((c: any) => !existingSubEventClaimIds.has(c.id))
    .filter((c: any) => c.status === 'SUPPORTED' || c.status === 'DISPUTED')
    .map((c: any) => {
      const tokens = (c.claimText as string)
        .toLowerCase()
        .split(/\s+/)
        .filter((t: string) => t.length > 3);
      return { id: c.id, tokens, text: c.claimText };
    });

  if (claimTokens.length < CLAIM_DIVERGENCE_MIN) return null;

  // Find clusters: claims that share >= 3 tokens with each other
  const clusters: { claims: typeof claimTokens; sharedTokens: string[] }[] = [];

  for (let i = 0; i < claimTokens.length; i++) {
    let added = false;
    for (const cluster of clusters) {
      const shared = claimTokens[i].tokens.filter((t) =>
        cluster.sharedTokens.includes(t),
      );
      if (shared.length >= 2) {
        cluster.claims.push(claimTokens[i]);
        cluster.sharedTokens = shared;
        added = true;
        break;
      }
    }
    if (!added) {
      clusters.push({
        claims: [claimTokens[i]],
        sharedTokens: [...claimTokens[i].tokens],
      });
    }
  }

  // Find clusters with >= CLAIM_DIVERGENCE_MIN claims
  for (const cluster of clusters) {
    if (cluster.claims.length >= CLAIM_DIVERGENCE_MIN) {
      const topTokens = cluster.sharedTokens.slice(0, 3).join(' ');
      return {
        label: `RAMA: ${topTokens}`,
        claimIds: cluster.claims.map((c) => c.id),
      };
    }
  }

  return null;
}

export class SubEventBuilder {
  constructor(
    private topicRepo: TopicAssignmentRepository,
    private claimRepo: ClaimRepository,
    private versionRepo: VersionRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, version_id } = envelope.payload as {
        event_id: string;
        version_id: string;
      };
      const traceId = envelope.trace.trace_id;

      const version = await this.versionRepo.findById(version_id);
      if (!version) {
        logger.error({ event_id, version_id }, 'version_not_found_for_subevents');
        return;
      }

      const existingPacket = (version.packetJson as any) ?? {};
      const existingSubEvents: SubEvent[] = existingPacket.subevents ?? [];
      const existingClaimIds = new Set(existingSubEvents.flatMap((se) => se.key_claim_ids));

      const rawHeatmap = existingPacket.topics_heatmap;
      const heatmap: HeatmapBin[] = Array.isArray(rawHeatmap) ? rawHeatmap : [];
      const newSubEvents: SubEvent[] = [...existingSubEvents];

      // Trigger 1: Topic drift
      const drift = detectTopicDrift(heatmap);
      if (drift && !existingSubEvents.some((se) => se.label.includes('FASE'))) {
        // Get article_ids from topic assignments for the drift topic
        const assignments = await this.topicRepo.findByEventAndVersion(event_id, version_id);
        const driftArticles = assignments
          .filter((a) => a.topicKey === drift.driftTopic)
          .map((a) => a.articleId);
        const uniqueArticles = [...new Set(driftArticles)];

        newSubEvents.push({
          sub_event_id: ulid(),
          label: `FASE 2: ${drift.driftTopic}`,
          predicate_summary: `Cambio temático sostenido hacia ${drift.driftTopic} a partir del bin ${drift.startBin}`,
          article_ids: uniqueArticles,
          key_claim_ids: [],
        });
      }

      // Trigger 2: Claim divergence
      const claims = await this.claimRepo.findClaimsByVersion(event_id, version_id);
      const divergence = detectClaimDivergence(claims, existingClaimIds);
      if (divergence && !existingSubEvents.some((se) => se.label === divergence.label)) {
        newSubEvents.push({
          sub_event_id: ulid(),
          label: divergence.label,
          predicate_summary: `Grupo de ${divergence.claimIds.length} claims divergentes`,
          article_ids: [],
          key_claim_ids: divergence.claimIds,
        });
      }

      // Update packet
      if (newSubEvents.length !== existingSubEvents.length) {
        const updatedPacket = {
          ...existingPacket,
          subevents: newSubEvents,
        };
        await this.versionRepo.update(version_id, { packetJson: updatedPacket });
      }

      await this.auditWriter.write({
        entity_type: 'SUB_EVENT',
        entity_id: event_id,
        action: 'SUBEVENTS_BUILT',
        trace_id: traceId,
        data: { version_id, subevent_count: newSubEvents.length },
      });

      await this.eventBus.publish({
        event_name: 'SubEventsBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'subevents' },
        payload: { event_id, version_id, subevent_count: newSubEvents.length },
      });
    };
  }
}
