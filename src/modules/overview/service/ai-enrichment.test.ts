import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPublishedHandler } from './ai-enrichment.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { ulid } from 'ulid';

function makeEnvelope(eventId: string) {
  return {
    event_name: 'EventPublished',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { event_id: eventId, published_at: new Date().toISOString() },
  };
}

describe('ai-enrichment: createPublishedHandler', () => {
  let versionRepo: any;
  let claimRepo: any;
  let claimExtractor: any;
  let overviewGenerator: any;

  beforeEach(() => {
    versionRepo = {
      findLatestByEventId: vi.fn(),
      findById: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    };
    claimRepo = {
      countClaimsByVersion: vi.fn(),
    };
    claimExtractor = {
      handler: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
    };
    overviewGenerator = {
      handler: vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined)),
    };
  });

  it('skips if no version exists', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue(null);

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    await handler(makeEnvelope('ev-1'));

    expect(claimExtractor.handler).not.toHaveBeenCalled();
    expect(overviewGenerator.handler).not.toHaveBeenCalled();
  });

  it('skips if ai_run_version_id matches (idempotent)', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue({
      id: 'ver-1',
      versionIndex: 0,
      packetJson: { ai_run_version_id: 'ver-1' },
    });

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    await handler(makeEnvelope('ev-1'));

    expect(claimExtractor.handler).not.toHaveBeenCalled();
    expect(overviewGenerator.handler).not.toHaveBeenCalled();
  });

  it('runs claim extraction when no claims exist', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue({
      id: 'ver-1',
      versionIndex: 0,
      packetJson: {},
    });
    claimRepo.countClaimsByVersion.mockResolvedValue(0);
    versionRepo.findById.mockResolvedValue({ id: 'ver-1', packetJson: {} });

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    await handler(makeEnvelope('ev-1'));

    expect(claimExtractor.handler).toHaveBeenCalled();
    expect(overviewGenerator.handler).toHaveBeenCalled();
    // Should mark as completed
    expect(versionRepo.update).toHaveBeenCalledWith('ver-1', expect.objectContaining({
      packetJson: expect.objectContaining({ ai_run_version_id: 'ver-1' }),
    }));
  });

  it('skips claim extraction when claims already exist', async () => {
    versionRepo.findLatestByEventId.mockResolvedValue({
      id: 'ver-1',
      versionIndex: 0,
      packetJson: {},
    });
    claimRepo.countClaimsByVersion.mockResolvedValue(5);
    versionRepo.findById.mockResolvedValue({ id: 'ver-1', packetJson: {} });

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    await handler(makeEnvelope('ev-1'));

    // Claim extraction skipped, but overview still runs
    expect(claimExtractor.handler).not.toHaveBeenCalled();
    expect(overviewGenerator.handler).toHaveBeenCalled();
  });

  it('does not throw on error (best-effort)', async () => {
    versionRepo.findLatestByEventId.mockRejectedValue(new Error('db down'));

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    // Should not throw
    await expect(handler(makeEnvelope('ev-1'))).resolves.toBeUndefined();
  });

  it('second call after first completes is idempotent', async () => {
    // First call: no ai_run_version_id
    versionRepo.findLatestByEventId.mockResolvedValue({
      id: 'ver-1',
      versionIndex: 0,
      packetJson: {},
    });
    claimRepo.countClaimsByVersion.mockResolvedValue(3);
    versionRepo.findById.mockResolvedValue({ id: 'ver-1', packetJson: {} });

    const handler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
    await handler(makeEnvelope('ev-1'));

    expect(overviewGenerator.handler).toHaveBeenCalledTimes(1);

    // Second call: ai_run_version_id is now set
    versionRepo.findLatestByEventId.mockResolvedValue({
      id: 'ver-1',
      versionIndex: 0,
      packetJson: { ai_run_version_id: 'ver-1' },
    });

    await handler(makeEnvelope('ev-1'));

    // Should not have been called again
    expect(overviewGenerator.handler).toHaveBeenCalledTimes(1);
  });
});
