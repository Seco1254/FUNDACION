import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaimQuoteExtractor, splitSentences, normalizeClaim, classifyClaim, classifyStrength, classifyRole, computeStatus, detectContradictions } from './claim-extractor.js';
import { EventBus } from '../../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../../core/event_bus/envelope.js';
import { ulid } from 'ulid';

function makeVersionCommittedEnvelope(eventId: string, versionIndex: number): EventEnvelope {
  return {
    event_name: 'EventVersionCommitted',
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload: { event_id: eventId, version_id: 'ver-1', version_index: versionIndex },
  };
}

describe('ClaimQuoteExtractor helpers', () => {
  describe('splitSentences', () => {
    it('splits on periods', () => {
      const result = splitSentences('Primera oración. Segunda oración.');
      expect(result).toEqual(['Primera oración.', 'Segunda oración.']);
    });

    it('splits on semicolons and colons', () => {
      const result = splitSentences('Parte uno; parte dos: parte tres.');
      expect(result).toEqual(['Parte uno;', 'parte dos:', 'parte tres.']);
    });

    it('preserves abbreviations like Sr. Dr.', () => {
      const result = splitSentences('El Sr. García declaró esto. Otra oración.');
      expect(result).toHaveLength(2);
      expect(result[0]).toContain('Sr.');
    });
  });

  describe('normalizeClaim', () => {
    it('lowercases and removes punctuation', () => {
      expect(normalizeClaim('¡Hola, Mundo!')).toBe('hola mundo');
    });

    it('collapses whitespace', () => {
      expect(normalizeClaim('  mucho   espacio  ')).toBe('mucho espacio');
    });
  });

  describe('classifyClaim', () => {
    it('returns QUANT for text with numbers', () => {
      expect(classifyClaim('El PIB creció un 3.5% en el primer trimestre')).toBe('QUANT');
    });

    it('returns ALLEGATION for attribution words', () => {
      expect(classifyClaim('Según el ministro, la reforma es necesaria')).toBe('ALLEGATION');
    });

    it('returns FORECAST for speculative language', () => {
      expect(classifyClaim('Se espera que la inflación baje el próximo mes')).toBe('FORECAST');
    });

    it('returns OPINION for criticism/opinion words', () => {
      expect(classifyClaim('El senador criticó la decisión del gobierno sobre la reforma')).toBe('OPINION');
    });

    it('returns FACT for neutral statements', () => {
      expect(classifyClaim('El congreso aprobó la ley en sesión extraordinaria del martes')).toBe('FACT');
    });
  });

  describe('classifyStrength', () => {
    it('returns STRONG for multi-media (>=2)', () => {
      expect(classifyStrength('texto genérico', 2)).toBe('STRONG');
    });

    it('returns STRONG for text with numbers', () => {
      expect(classifyStrength('El PIB creció 3.5% en el trimestre', 1)).toBe('STRONG');
    });

    it('returns STRONG for attribution text', () => {
      expect(classifyStrength('Según el ministro, la reforma es positiva', 1)).toBe('STRONG');
    });

    it('returns WEAK for vague language', () => {
      expect(classifyStrength('Al parecer esto sería algo importante', 1)).toBe('WEAK');
    });

    it('returns MEDIUM for long factual text', () => {
      const longText = 'El congreso aprobó la ley en sesión extraordinaria convocada por el presidente de la república para tratar el tema';
      expect(classifyStrength(longText, 1)).toBe('MEDIUM');
    });
  });

  describe('classifyRole', () => {
    it('returns ATTRIBUTION for ALLEGATION', () => {
      expect(classifyRole('ALLEGATION')).toBe('ATTRIBUTION');
    });

    it('returns ATTRIBUTION for OPINION', () => {
      expect(classifyRole('OPINION')).toBe('ATTRIBUTION');
    });

    it('returns EVIDENCE for FACT', () => {
      expect(classifyRole('FACT')).toBe('EVIDENCE');
    });
  });

  describe('detectContradictions', () => {
    it('marks claims with different numbers as contradicted', () => {
      const claims = new Map();
      claims.set('los muertos fueron 3 en la tragedia del rio', {
        claimTextNorm: 'los muertos fueron 3 en la tragedia del rio',
        claimType: 'QUANT' as any,
        quotes: [{ articleId: 'a1', mediaId: 'm1', quoteText: 'q', spanStart: null, spanEnd: null, strength: 'STRONG' as any, role: 'EVIDENCE' as any }],
      });
      claims.set('los muertos fueron 5 en la tragedia del rio', {
        claimTextNorm: 'los muertos fueron 5 en la tragedia del rio',
        claimType: 'QUANT' as any,
        quotes: [{ articleId: 'a2', mediaId: 'm2', quoteText: 'q', spanStart: null, spanEnd: null, strength: 'STRONG' as any, role: 'EVIDENCE' as any }],
      });

      detectContradictions(claims);

      const entries = Array.from(claims.values());
      expect((entries[0] as any)._contradicted).toBe(true);
      expect((entries[1] as any)._contradicted).toBe(true);
    });

    it('does not flag claims without shared tokens', () => {
      const claims = new Map();
      claims.set('reforma tributaria colombia gobierno', {
        claimTextNorm: 'reforma tributaria colombia gobierno',
        claimType: 'FACT' as any,
        quotes: [],
      });
      claims.set('futbol argentina mundial qatar seleccion', {
        claimTextNorm: 'futbol argentina mundial qatar seleccion',
        claimType: 'FACT' as any,
        quotes: [],
      });

      detectContradictions(claims);

      const entries = Array.from(claims.values());
      expect((entries[0] as any)._contradicted).toBeUndefined();
      expect((entries[1] as any)._contradicted).toBeUndefined();
    });
  });

  describe('computeStatus', () => {
    it('returns DISPUTED for contradicted claims', () => {
      const claim = {
        claimTextNorm: 'test',
        claimType: 'FACT' as any,
        quotes: [{ strength: 'STRONG' as any, mediaId: 'm1' }],
        _contradicted: true,
      };
      expect(computeStatus(claim as any)).toBe('DISPUTED');
    });

    it('returns SUPPORTED for claim with STRONG quote', () => {
      const claim = {
        claimTextNorm: 'test',
        claimType: 'FACT' as any,
        quotes: [{ strength: 'STRONG' as any, mediaId: 'm1' }],
      };
      expect(computeStatus(claim as any)).toBe('SUPPORTED');
    });

    it('returns SUPPORTED for 2 MEDIUM quotes from different media', () => {
      const claim = {
        claimTextNorm: 'test',
        claimType: 'FACT' as any,
        quotes: [
          { strength: 'MEDIUM' as any, mediaId: 'm1' },
          { strength: 'MEDIUM' as any, mediaId: 'm2' },
        ],
      };
      expect(computeStatus(claim as any)).toBe('SUPPORTED');
    });

    it('returns INSUFFICIENT for only WEAK quotes', () => {
      const claim = {
        claimTextNorm: 'test',
        claimType: 'FACT' as any,
        quotes: [{ strength: 'WEAK' as any, mediaId: 'm1' }],
      };
      expect(computeStatus(claim as any)).toBe('INSUFFICIENT');
    });

    it('returns INSUFFICIENT for 1 MEDIUM from 1 media', () => {
      const claim = {
        claimTextNorm: 'test',
        claimType: 'FACT' as any,
        quotes: [{ strength: 'MEDIUM' as any, mediaId: 'm1' }],
      };
      expect(computeStatus(claim as any)).toBe('INSUFFICIENT');
    });
  });
});

describe('ClaimQuoteExtractor handler', () => {
  let eventBus: EventBus;
  let published: EventEnvelope[];
  let eventRepo: any;
  let versionRepo: any;
  let mediaRepo: any;
  let claimRepo: any;
  let auditWriter: any;
  let createdClaims: any[];
  let createdQuotes: any[];

  beforeEach(() => {
    eventBus = new EventBus();
    published = [];
    vi.spyOn(eventBus, 'publish').mockImplementation(async (env: EventEnvelope) => {
      published.push(env);
    });
    auditWriter = { write: vi.fn().mockResolvedValue(undefined) };

    createdClaims = [];
    createdQuotes = [];

    eventRepo = {
      findArticlesForEvent: vi.fn().mockResolvedValue([]),
    };

    versionRepo = {
      findLatestByEventId: vi.fn().mockResolvedValue({
        id: 'ver-1',
        versionIndex: 0,
        packetJson: {},
      }),
    };

    mediaRepo = {
      findById: vi.fn().mockResolvedValue({ id: 'media-1', mediaKey: 'eltiempo' }),
    };

    claimRepo = {
      countClaimsByVersion: vi.fn().mockResolvedValue(0),
      createClaim: vi.fn().mockImplementation(async (data: any) => {
        const claim = { id: `claim-${createdClaims.length + 1}`, ...data };
        createdClaims.push(claim);
        return claim;
      }),
      createQuote: vi.fn().mockImplementation(async (data: any) => {
        const quote = { id: `quote-${createdQuotes.length + 1}`, ...data };
        createdQuotes.push(quote);
        return quote;
      }),
    };
  });

  it('extracts claims and quotes from articles and emits ClaimGraphBuilt', async () => {
    eventRepo.findArticlesForEvent.mockResolvedValue([
      {
        id: 'art-1',
        mediaId: 'media-1',
        title: 'Reforma tributaria en Colombia afecta a millones de ciudadanos',
        snippet: 'El gobierno colombiano presentó la nueva reforma tributaria que aumentará los impuestos en un 15% para las empresas grandes.',
      },
    ]);

    const extractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter);
    await extractor.handler()(makeVersionCommittedEnvelope('ev-1', 0));

    expect(createdClaims.length).toBeGreaterThan(0);
    expect(createdQuotes.length).toBeGreaterThan(0);

    expect(published).toHaveLength(1);
    expect(published[0].event_name).toBe('ClaimGraphBuilt');
    expect(published[0].payload).toHaveProperty('event_id', 'ev-1');
    expect(published[0].payload).toHaveProperty('version_id', 'ver-1');
  });

  it('skips when claims already exist for version (idempotency)', async () => {
    claimRepo.countClaimsByVersion.mockResolvedValue(5);

    const extractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter);
    await extractor.handler()(makeVersionCommittedEnvelope('ev-1', 0));

    expect(claimRepo.createClaim).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it('ignores sentences shorter than 40 chars', async () => {
    eventRepo.findArticlesForEvent.mockResolvedValue([
      {
        id: 'art-1',
        mediaId: 'media-1',
        title: 'Corto',
        snippet: 'Muy corto.',
      },
    ]);

    const extractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter);
    await extractor.handler()(makeVersionCommittedEnvelope('ev-1', 0));

    expect(createdClaims.length).toBe(0);
  });

  it('deduplicates claims with same normalized text', async () => {
    eventRepo.findArticlesForEvent.mockResolvedValue([
      {
        id: 'art-1',
        mediaId: 'media-1',
        title: 'El gobierno presentó la reforma tributaria del país este martes',
        snippet: 'El gobierno presentó la reforma tributaria del país este martes.',
      },
      {
        id: 'art-2',
        mediaId: 'media-2',
        title: 'El gobierno presentó la reforma tributaria del país este martes',
        snippet: 'El gobierno presentó la reforma tributaria del país este martes.',
      },
    ]);

    const extractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditWriter);
    await extractor.handler()(makeVersionCommittedEnvelope('ev-1', 0));

    // Same normalized text → only 1 claim, but 2 quotes (one per article)
    expect(createdClaims.length).toBe(1);
    expect(createdQuotes.length).toBe(2);
  });
});
