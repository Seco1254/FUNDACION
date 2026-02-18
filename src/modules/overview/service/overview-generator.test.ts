import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OverviewGenerator } from './overview-generator.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';

function makeClaimGraphBuiltEnvelope(eventId: string, versionId: string): EventEnvelope {
  return {
    event_name: 'ClaimGraphBuilt',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { event_id: eventId, version_id: versionId },
  };
}

function makeClaim(overrides: any = {}) {
  return {
    id: overrides.id ?? ulid(),
    claimText: overrides.claimText ?? 'test claim text',
    claimType: overrides.claimType ?? 'FACT',
    status: overrides.status ?? 'SUPPORTED',
    quotes: overrides.quotes ?? [],
  };
}

function makeQuote(overrides: any = {}) {
  return {
    id: overrides.id ?? ulid(),
    articleId: overrides.articleId ?? 'art-1',
    quoteText: overrides.quoteText ?? 'test quote text',
    strength: overrides.strength ?? 'STRONG',
    role: overrides.role ?? 'EVIDENCE',
    article: {
      url: overrides.url ?? 'https://example.com/article',
      media: { mediaKey: overrides.mediaKey ?? 'eltiempo' },
    },
  };
}

describe('OverviewGenerator', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let claimRepo: any;
  let versionRepo: any;
  let auditWriter: any;

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };

    versionRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'ver-1',
        versionIndex: 0,
        packetJson: { event_id: 'ev-1', articles: [] },
      }),
      update: vi.fn().mockResolvedValue({}),
    };

    claimRepo = {
      findClaimsWithQuotesByVersion: vi.fn().mockResolvedValue([]),
    };
  });

  describe('buildOverview', () => {
    it('Test 1: "No bullet sin cita" - no bullets when no valid citations, gate FAIL', () => {
      // Claims with no quotes → no citations → no bullets
      const claims = [
        makeClaim({ status: 'SUPPORTED', quotes: [] }),
        makeClaim({ status: 'SUPPORTED', quotes: [] }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      // No bullets should exist (hard rule: no bullet without citation_refs)
      const allBullets = result.sections.flatMap((s) => s.bullets);
      expect(allBullets).toHaveLength(0);
      expect(result.gate_status).toBe('FAIL');
    });

    it('Test 2: Caso PASS mínimo - 2 SUPPORTED claims with citations → PASS', () => {
      const claims = [
        makeClaim({
          id: 'claim-1',
          claimText: 'el gobierno presentó la reforma tributaria que afecta al país',
          claimType: 'FACT',
          status: 'SUPPORTED',
          quotes: [
            makeQuote({ id: 'q1', articleId: 'art-1', mediaKey: 'eltiempo', url: 'https://eltiempo.com/1' }),
            makeQuote({ id: 'q2', articleId: 'art-2', mediaKey: 'elespectador', url: 'https://elespectador.com/1' }),
          ],
        }),
        makeClaim({
          id: 'claim-2',
          claimText: 'los impuestos aumentarán un 15 por ciento para grandes empresas',
          claimType: 'QUANT',
          status: 'SUPPORTED',
          quotes: [
            makeQuote({ id: 'q3', articleId: 'art-1', mediaKey: 'eltiempo', url: 'https://eltiempo.com/1' }),
          ],
        }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      expect(result.gate_status).toBe('PASS');
      expect(result.quality_flags.supported_count).toBe(2);

      // All bullets must have citation_refs
      const allBullets = result.sections.flatMap((s) => s.bullets);
      expect(allBullets.length).toBeGreaterThanOrEqual(2);
      for (const bullet of allBullets) {
        expect(bullet.citation_refs.length).toBeGreaterThan(0);
      }

      // FACT/QUANT SUPPORTED → "Qué pasó"
      const quePaso = result.sections.find((s) => s.key === 'que_paso')!;
      expect(quePaso.bullets.length).toBe(2);
    });

    it('Test 3: Contradicción por número → DISPUTED en "En disputa" con citas', () => {
      const claims = [
        makeClaim({
          id: 'claim-a',
          claimText: 'los muertos fueron 3 en la tragedia del rio',
          claimType: 'QUANT',
          status: 'DISPUTED',
          quotes: [
            makeQuote({ id: 'qa', articleId: 'art-1', mediaKey: 'eltiempo', url: 'https://eltiempo.com/1' }),
          ],
        }),
        makeClaim({
          id: 'claim-b',
          claimText: 'los muertos fueron 5 en la tragedia del rio',
          claimType: 'QUANT',
          status: 'DISPUTED',
          quotes: [
            makeQuote({ id: 'qb', articleId: 'art-2', mediaKey: 'elespectador', url: 'https://elespectador.com/1' }),
          ],
        }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      const enDisputa = result.sections.find((s) => s.key === 'en_disputa')!;
      expect(enDisputa.bullets).toHaveLength(2);

      // Each disputed bullet must have citation
      for (const bullet of enDisputa.bullets) {
        expect(bullet.citation_refs.length).toBeGreaterThan(0);
        expect(bullet.status).toBe('DISPUTED');
      }

      // "Qué pasó" and "Contexto" should be empty (no SUPPORTED claims)
      expect(result.gate_status).toBe('FAIL');
      const quePaso = result.sections.find((s) => s.key === 'que_paso')!;
      expect(quePaso.bullets).toHaveLength(0);
    });

    it('INSUFFICIENT claims go only to "Qué falta por confirmar"', () => {
      const claims = [
        makeClaim({
          id: 'claim-i',
          claimText: 'al parecer sería un cambio importante para la economía nacional',
          claimType: 'FACT',
          status: 'INSUFFICIENT',
          quotes: [
            makeQuote({ id: 'qi', articleId: 'art-1', mediaKey: 'eltiempo' }),
          ],
        }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      const queFalta = result.sections.find((s) => s.key === 'que_falta')!;
      expect(queFalta.bullets).toHaveLength(1);

      const quePaso = result.sections.find((s) => s.key === 'que_paso')!;
      expect(quePaso.bullets).toHaveLength(0);

      expect(result.gate_status).toBe('FAIL');
    });

    it('ALLEGATION SUPPORTED claims go to "Contexto"', () => {
      const claims = [
        makeClaim({ status: 'SUPPORTED', claimType: 'ALLEGATION', quotes: [makeQuote()] }),
        makeClaim({ status: 'SUPPORTED', claimType: 'ALLEGATION', quotes: [makeQuote()] }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      const contexto = result.sections.find((s) => s.key === 'contexto')!;
      expect(contexto.bullets).toHaveLength(2);
      expect(result.gate_status).toBe('PASS');
    });

    it('handles claims with missing quotes gracefully', () => {
      const claims = [
        { id: 'claim-no-quotes', claimText: 'missing quotes field', claimType: 'FACT', status: 'SUPPORTED' },
        makeClaim({ status: 'SUPPORTED', quotes: [makeQuote()] }),
        makeClaim({ status: 'SUPPORTED', quotes: [makeQuote()] }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      // Claim without quotes should be skipped (no citations)
      expect(result.gate_status).toBe('PASS');
      const allBullets = result.sections.flatMap((s) => s.bullets);
      expect(allBullets).toHaveLength(2);
    });

    it('quality_flags has correct evidence_rate', () => {
      const claims = [
        makeClaim({ status: 'SUPPORTED', quotes: [makeQuote()] }),
        makeClaim({ status: 'INSUFFICIENT', quotes: [makeQuote()] }),
        makeClaim({ status: 'DISPUTED', quotes: [makeQuote()] }),
      ];

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildOverview(claims);

      expect(result.quality_flags.supported_count).toBe(1);
      expect(result.quality_flags.disputed_count).toBe(1);
      expect(result.quality_flags.evidence_rate).toBeCloseTo(1 / 3, 5);
    });
  });

  describe('handler', () => {
    it('updates version packet_json with overview and emits OverviewGenerated', async () => {
      claimRepo.findClaimsWithQuotesByVersion.mockResolvedValue([
        makeClaim({
          status: 'SUPPORTED',
          claimType: 'FACT',
          quotes: [makeQuote({ mediaKey: 'eltiempo' })],
        }),
        makeClaim({
          status: 'SUPPORTED',
          claimType: 'QUANT',
          quotes: [makeQuote({ mediaKey: 'elespectador' })],
        }),
      ]);

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      await gen.handler()(makeClaimGraphBuiltEnvelope('ev-1', 'ver-1'));

      // Should update version
      expect(versionRepo.update).toHaveBeenCalledOnce();
      const updateCall = versionRepo.update.mock.calls[0];
      expect(updateCall[0]).toBe('ver-1');
      expect(updateCall[1].gateStatus).toBe('PASS');

      const updatedPacket = updateCall[1].packetJson;
      expect(updatedPacket.overview.gate_status).toBe('PASS');
      expect(updatedPacket.overview.sections).toHaveLength(4);
      expect(updatedPacket.claims_count).toBe(2);
      expect(updatedPacket.quality_flags.supported_count).toBe(2);

      // Should emit OverviewGenerated
      expect(published).toHaveLength(1);
      expect(published[0].event_name).toBe('OverviewGenerated');
      expect(published[0].payload).toHaveProperty('gate_status', 'PASS');
    });

    it('sets gate_status FAIL when insufficient claims', async () => {
      claimRepo.findClaimsWithQuotesByVersion.mockResolvedValue([
        makeClaim({
          status: 'INSUFFICIENT',
          quotes: [makeQuote()],
        }),
      ]);

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      await gen.handler()(makeClaimGraphBuiltEnvelope('ev-1', 'ver-1'));

      const updateCall = versionRepo.update.mock.calls[0];
      expect(updateCall[1].gateStatus).toBe('FAIL');
      expect(published[0].payload).toHaveProperty('gate_status', 'FAIL');
    });
  });
});
