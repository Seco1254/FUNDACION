import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventBus, EventEnvelope } from '../../../core/event_bus/index.js';
import { detectTopicDrift, detectClaimDivergence, SubEventBuilder } from './subevent-builder.js';
import type { HeatmapBin } from '../../topics/domain/types.js';
import { ulid } from 'ulid';

describe('SubEvents: topic drift detection', () => {
  it('detects drift when different topic dominates for ≥3 consecutive bins', () => {
    const heatmap: HeatmapBin[] = [
      { bin_index: 0, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.8, POLITICA: 0.2 } },
      { bin_index: 1, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.7, POLITICA: 0.3 } },
      { bin_index: 2, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.6, ECONOMIA: 0.4 } },
      { bin_index: 3, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.7, ECONOMIA: 0.3 } },
      { bin_index: 4, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.8, ECONOMIA: 0.2 } },
    ];

    const drift = detectTopicDrift(heatmap);
    expect(drift).not.toBeNull();
    expect(drift!.driftTopic).toBe('SEGURIDAD');
    expect(drift!.startBin).toBe(2);
  });

  it('no drift when topic stays the same', () => {
    const heatmap: HeatmapBin[] = [
      { bin_index: 0, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.8 } },
      { bin_index: 1, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.7 } },
      { bin_index: 2, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.6 } },
    ];

    const drift = detectTopicDrift(heatmap);
    expect(drift).toBeNull();
  });

  it('no drift when different topic appears but not for 3 consecutive bins', () => {
    const heatmap: HeatmapBin[] = [
      { bin_index: 0, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.8 } },
      { bin_index: 1, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.7 } },
      { bin_index: 2, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.6 } },
      { bin_index: 3, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.7 } },
    ];

    const drift = detectTopicDrift(heatmap);
    expect(drift).toBeNull();
  });
});

describe('SubEvents: claim divergence', () => {
  it('detects divergence with ≥3 claims sharing tokens', () => {
    const claims = [
      { id: 'c1', claimText: 'reforma tributaria gobierno presupuesto fiscal aprobada', status: 'SUPPORTED' },
      { id: 'c2', claimText: 'reforma tributaria gobierno presupuesto fiscal rechazada', status: 'DISPUTED' },
      { id: 'c3', claimText: 'reforma tributaria gobierno presupuesto fiscal modificada', status: 'SUPPORTED' },
    ];
    const result = detectClaimDivergence(claims, new Set());
    expect(result).not.toBeNull();
    expect(result!.claimIds.length).toBeGreaterThanOrEqual(3);
    expect(result!.label).toMatch(/^RAMA:/);
  });

  it('no divergence with fewer than 3 claims', () => {
    const claims = [
      { id: 'c1', claimText: 'reforma tributaria gobierno presupuesto', status: 'SUPPORTED' },
      { id: 'c2', claimText: 'reforma tributaria gobierno presupuesto', status: 'DISPUTED' },
    ];
    const result = detectClaimDivergence(claims, new Set());
    expect(result).toBeNull();
  });
});

describe('SubEventBuilder handler', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let topicRepo: any;
  let claimRepo: any;
  let versionRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    published = [];
    eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });

    topicRepo = {
      findByEventAndVersion: vi.fn().mockResolvedValue([]),
    };

    claimRepo = {
      findClaimsByVersion: vi.fn().mockResolvedValue([]),
    };

    versionRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'ver-1',
        packetJson: {
          topics_heatmap: [
            { bin_index: 0, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.8 } },
            { bin_index: 1, bin_start: '', bin_end: '', topics: { ECONOMIA: 0.7 } },
            { bin_index: 2, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.9 } },
            { bin_index: 3, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.8 } },
            { bin_index: 4, bin_start: '', bin_end: '', topics: { SEGURIDAD: 0.7 } },
          ],
        },
      }),
      update: vi.fn().mockResolvedValue({}),
    };

    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };
  });

  it('creates subevent on sustained topic drift', async () => {
    topicRepo.findByEventAndVersion.mockResolvedValue([
      { articleId: 'art-1', topicKey: 'SEGURIDAD' },
      { articleId: 'art-2', topicKey: 'SEGURIDAD' },
    ]);

    const builder = new SubEventBuilder(topicRepo, claimRepo, versionRepo, eventBus, auditWriter);
    await builder.handler()({
      event_name: 'TopicHeatmapBuilt',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1' },
    });

    expect(versionRepo.update).toHaveBeenCalledOnce();
    const updatedPacket = versionRepo.update.mock.calls[0][1].packetJson;
    expect(updatedPacket.subevents).toHaveLength(1);
    expect(updatedPacket.subevents[0].label).toContain('FASE 2');
    expect(updatedPacket.subevents[0].article_ids).toContain('art-1');

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('SubEventsBuilt');
  });

  it('handles corrupted topics_heatmap (non-array) gracefully', async () => {
    versionRepo.findById.mockResolvedValue({
      id: 'ver-1',
      packetJson: { topics_heatmap: 'corrupted-string' },
    });

    const builder = new SubEventBuilder(topicRepo, claimRepo, versionRepo, eventBus, auditWriter);
    await builder.handler()({
      event_name: 'TopicHeatmapBuilt',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1' },
    });

    // Should not crash, should emit event normally
    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('SubEventsBuilt');
  });

  it('emits SubEventsBuilt even without new subevents', async () => {
    versionRepo.findById.mockResolvedValue({
      id: 'ver-1',
      packetJson: { topics_heatmap: [] },
    });

    const builder = new SubEventBuilder(topicRepo, claimRepo, versionRepo, eventBus, auditWriter);
    await builder.handler()({
      event_name: 'TopicHeatmapBuilt',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
      payload: { event_id: 'ev-1', version_id: 'ver-1' },
    });

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('SubEventsBuilt');
  });
});
