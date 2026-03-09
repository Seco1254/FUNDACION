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

    it('uses text fallback when gate FAIL and articles have textNorm', async () => {
      claimRepo.findClaimsWithQuotesByVersion.mockResolvedValue([
        makeClaim({
          status: 'INSUFFICIENT',
          quotes: [makeQuote()],
        }),
      ]);

      const eventRepo = {
        findArticlesForEvent: vi.fn().mockResolvedValue([
          {
            title: 'Reforma tributaria aprobada en Colombia',
            textNorm: 'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor. La medida establece un aumento del 15 por ciento en la recaudación fiscal, lo que representaría ingresos adicionales de aproximadamente 18 billones de pesos para el Estado colombiano. Los gremios económicos del país expresaron su preocupación por el impacto que podría tener la reforma en la competitividad empresarial. Según el ministro de Hacienda, los recursos adicionales se destinarán a programas de educación y salud. El presidente señaló que la reforma es necesaria para financiar los programas sociales comprometidos en el Plan Nacional de Desarrollo. La propuesta será presentada oficialmente ante el Congreso en las próximas semanas. Analistas económicos consideran que el proyecto podría enfrentar una fuerte oposición en el Senado. La reforma también propone simplificar el sistema tributario reduciendo el número de declaraciones anuales requeridas. El Banco de la República indicó que monitorea con atención los posibles efectos de la reforma sobre la inflación y las tasas de interés.',
            snippet: 'El Congreso aprobó la reforma tributaria.',
            url: 'https://eltiempo.com/reforma',
            media: { mediaKey: 'eltiempo' },
          },
        ]),
      };

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter, null, eventRepo as any);
      await gen.handler()(makeClaimGraphBuiltEnvelope('ev-1', 'ver-1'));

      const updateCall = versionRepo.update.mock.calls[0];
      const packet = updateCall[1].packetJson;
      expect(packet.overview_mode).toBe('fallback');
      expect(packet.ai_overview.status).toBe('FALLBACK');
      const wh = packet.ai_overview.what_happened as string[];
      expect(wh.length).toBeGreaterThanOrEqual(3);
      expect(packet.ai_overview.confidence_label).toBe('Baja');
    });

    it('does NOT generate text fallback when article text is too short', async () => {
      claimRepo.findClaimsWithQuotesByVersion.mockResolvedValue([
        makeClaim({
          status: 'INSUFFICIENT',
          quotes: [makeQuote()],
        }),
      ]);

      const eventRepo = {
        findArticlesForEvent: vi.fn().mockResolvedValue([
          {
            title: 'Título corto',
            textNorm: 'Texto demasiado corto.',
            snippet: 'Snippet corto.',
            url: 'https://eltiempo.com/short',
            media: { mediaKey: 'eltiempo' },
          },
        ]),
      };

      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter, null, eventRepo as any);
      await gen.handler()(makeClaimGraphBuiltEnvelope('ev-1', 'ver-1'));

      const updateCall = versionRepo.update.mock.calls[0];
      const packet = updateCall[1].packetJson;
      // Falls back to heuristic (not fallback) since text is too short
      expect(packet.overview_mode).toBe('heuristic');
    });
  });

  describe('buildTextFallbackOverview', () => {
    it('extracts facts from article text when text >= 800 chars', () => {
      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildTextFallbackOverview([
        {
          title: 'Reforma tributaria aprobada',
          textNorm: 'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra en la plenaria del Senado. La medida establece un aumento del 15 por ciento en la recaudación fiscal, lo que representaría ingresos adicionales de aproximadamente 18 billones de pesos para el Estado colombiano. Los gremios económicos del país, representados por la ANDI y Fenalco, expresaron su preocupación por el impacto en la competitividad empresarial. Según el ministro de Hacienda, los recursos adicionales se destinarán a programas de educación y salud en las zonas rurales del país. El presidente señaló que la reforma es necesaria para financiar los programas sociales comprometidos en el Plan Nacional de Desarrollo. La propuesta será presentada oficialmente ante el Congreso de la República en las próximas semanas y se espera que el debate legislativo se extienda durante al menos tres meses. Analistas económicos consideran que el proyecto podría enfrentar una fuerte oposición en el Senado. La reforma también propone simplificar el sistema tributario, reduciendo el número de declaraciones anuales requeridas.',
          snippet: 'El Congreso aprobó la reforma.',
          url: 'https://eltiempo.com/reforma',
          mediaKey: 'eltiempo',
        },
      ]);

      expect(result).not.toBeNull();
      expect((result!.what_happened as string[]).length).toBeGreaterThanOrEqual(3);
      expect(result!.confidence_label).toBe('Baja');
      expect(result!.status).toBe('FALLBACK');
    });

    it('returns null when article text < 200 chars (fallback threshold)', () => {
      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const result = gen.buildTextFallbackOverview([
        {
          title: 'Breve',
          textNorm: 'Texto muy corto.',
          snippet: 'Snippet.',
          url: 'https://example.com/short',
          mediaKey: 'eltiempo',
        },
      ]);

      expect(result).toBeNull();
    });

    it('produces overview for text between 200-800 chars (lowered fallback threshold)', () => {
      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      // ~250 chars — above 200 fallback threshold but below 800 LLM threshold
      const text = 'El presidente de Colombia anunció hoy nuevas medidas económicas para enfrentar la inflación que ha golpeado a los sectores más vulnerables del país durante los últimos meses, incluyendo subsidios directos y control de precios en productos básicos de la canasta familiar colombiana.';
      const result = gen.buildTextFallbackOverview([
        {
          title: 'Colombia anuncia nuevas medidas económicas',
          textNorm: text,
          snippet: '',
          url: 'https://example.com/a',
          mediaKey: 'eltiempo',
        },
      ]);

      expect(result).not.toBeNull();
      expect((result!.what_happened as string[]).length).toBeGreaterThan(0);
      expect(result!.status).toBe('FALLBACK');
    });

    it('uses title as fallback when sentences too short to extract', () => {
      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      // 300+ chars of real words but each sentence < 40 chars so no sentences qualify
      const text = 'Dato primero corto. Dato segundo corto. Dato tercero rápido. Dato cuarto breve. Dato quinto simple. Dato sexto rápido. Dato séptimo corto. Dato octavo breve. Dato noveno corto. Dato décimo simple. Dato once corto. Dato doce breve. Dato trece simple. Dato catorce rápido. Dato quince corto. Dato dieciséis.';
      const result = gen.buildTextFallbackOverview([
        {
          title: 'El gobierno colombiano anuncia plan de emergencia económica',
          textNorm: text,
          snippet: '',
          url: 'https://example.com/c',
          mediaKey: 'eltiempo',
        },
      ]);

      expect(result).not.toBeNull();
      // Should have used title as fallback
      expect((result!.what_happened as string[])).toContain('El gobierno colombiano anuncia plan de emergencia económica');
    });

    it('uses Media confidence when 2+ sources', () => {
      const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);
      const longText = 'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra en la plenaria del Senado, después de un extenso debate. La medida establece un aumento del 15 por ciento en la recaudación fiscal, lo que representaría ingresos adicionales de aproximadamente 18 billones de pesos para el Estado colombiano. Los gremios económicos del país, representados por la ANDI y Fenalco, expresaron su preocupación por el impacto que podría tener la reforma en la competitividad empresarial y en la generación de empleo formal. Según el ministro de Hacienda, los recursos adicionales se destinarán a programas de educación y salud en las zonas rurales del país. El presidente señaló que la reforma es necesaria para financiar los programas sociales comprometidos en el Plan Nacional de Desarrollo, especialmente aquellos dirigidos a las comunidades más vulnerables. La propuesta será presentada oficialmente ante el Congreso de la República en las próximas semanas y se espera que el debate legislativo se extienda durante al menos tres meses. Analistas económicos consideran que el proyecto podría enfrentar una fuerte oposición en el Senado, donde varios partidos han manifestado su desacuerdo con el incremento de impuestos.';
      const result = gen.buildTextFallbackOverview([
        { title: 'Título 1', textNorm: longText, snippet: 'S1', url: 'https://a.com/1', mediaKey: 'eltiempo' },
        { title: 'Título 2', textNorm: longText, snippet: 'S2', url: 'https://b.com/2', mediaKey: 'elespectador' },
      ]);

      expect(result).not.toBeNull();
      expect(result!.confidence_label).toBe('Media');
    });
  });
});
