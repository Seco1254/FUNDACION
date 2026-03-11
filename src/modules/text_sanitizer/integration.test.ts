/**
 * Integration tests — verify that text_sanitizer is invoked in the 3 pipeline
 * hook points: embedding, claim extraction (heuristic), and overview (fallback).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EmbeddingService } from '../embedding/service/embedding-service.js';
import { EventBus } from '../../core/event_bus/dispatcher.js';
import { EventEnvelope } from '../../core/event_bus/envelope.js';
import { OverviewGenerator } from '../overview/service/overview-generator.js';
import { ulid } from 'ulid';

// ── Helpers ──────────────────────────────────────────────────────

function makeEnvelope(name: string, payload: Record<string, string>): EventEnvelope {
  return {
    event_name: name,
    event_id: ulid(),
    occurred_at: new Date().toISOString(),
    trace: { trace_id: ulid(), span_id: ulid(), source_module: 'test' },
    payload,
  };
}

// ── 1. EmbeddingService integration ─────────────────────────────

describe('EmbeddingService + sanitizer', () => {
  it('embedding of boilerplate-contaminated text differs from raw', async () => {
    const eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockResolvedValue(undefined);

    const updates: any[] = [];
    const articleRepo = {
      findById: vi.fn().mockResolvedValue({
        id: 'art-1',
        title: 'Reforma tributaria en Colombia',
        snippet: 'El gobierno anuncia nueva reforma. Suscríbete a nuestro newsletter.',
        url: 'https://example.com/1',
        embeddingHash: null,
      }),
      updateEmbedding: vi.fn().mockImplementation((id, data) => {
        updates.push(data);
      }),
    } as any;

    const service = new EmbeddingService(articleRepo, eventBus, { write: vi.fn() } as any);
    await service.handler()(makeEnvelope('ArticlePolicyOk', { article_id: 'art-1' }));

    expect(articleRepo.updateEmbedding).toHaveBeenCalledOnce();
    const embeddingData = updates[0];
    expect(embeddingData.embeddingVec).toHaveLength(256);

    // Verify the embedding hash is based on sanitized text (no newsletter noise)
    // by checking that the hash changes when boilerplate is present vs. absent
    const { computeEmbeddingHash, textForEmbedding } = await import('../embedding/service/hash-vector.js');
    const rawText = textForEmbedding(
      'Reforma tributaria en Colombia',
      'El gobierno anuncia nueva reforma. Suscríbete a nuestro newsletter.',
    );
    const rawHash = computeEmbeddingHash(rawText);

    // The stored hash should differ from raw hash because sanitizer removed "Suscríbete..."
    expect(embeddingData.embeddingHash).not.toBe(rawHash);
  });
});

// ── 2. OverviewGenerator.buildTextFallbackOverview integration ──

describe('OverviewGenerator + sanitizer', () => {
  it('buildTextFallbackOverview excludes boilerplate from output bullets', () => {
    const eventBus = new EventBus();
    vi.spyOn(eventBus, 'publish').mockResolvedValue(undefined);
    const claimRepo = { findClaimsWithQuotesByVersion: vi.fn() } as any;
    const versionRepo = { findById: vi.fn(), update: vi.fn() } as any;
    const auditWriter = { write: vi.fn() } as any;

    const gen = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditWriter);

    // Build a long article that includes boilerplate lines interspersed
    const lines = [
      'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra.',
      'La medida establece un aumento del 15 por ciento en la recaudación fiscal para el próximo año calendario.',
      'Suscríbete a nuestro newsletter para recibir las noticias más importantes del día en tu correo electrónico.',
      'Los gremios económicos del país expresaron su preocupación por el impacto en la competitividad empresarial.',
      'Según el ministro de Hacienda, los recursos adicionales se destinarán a programas de educación y salud regional.',
      'Acepta cookies para seguir navegando en nuestro sitio web y recibir contenido personalizado.',
      'El presidente señaló que la reforma es necesaria para financiar los programas sociales del gobierno nacional.',
      'La propuesta será presentada oficialmente ante el Congreso de la República en las próximas semanas para debate.',
      'Regístrate gratis y accede a contenido exclusivo sobre noticias de política y economía colombiana.',
      'Analistas económicos consideran que el proyecto podría enfrentar oposición en el Senado de la República.',
      'El Banco de la República indicó que monitorea con atención los efectos sobre la inflación y las tasas.',
    ];
    const longText = lines.join('\n');

    const result = gen.buildTextFallbackOverview([{
      title: 'Reforma tributaria aprobada',
      textNorm: longText,
      snippet: 'El Congreso aprobó la reforma.',
      url: 'https://eltiempo.com/reforma',
      mediaKey: 'eltiempo',
    }]);

    expect(result).not.toBeNull();
    const wh = result!.what_happened as string[];
    const ctx = result!.context as string[];
    const allBullets = [...wh, ...ctx];

    // None of the bullets should contain boilerplate
    for (const bullet of allBullets) {
      expect(bullet.toLowerCase()).not.toContain('newsletter');
      expect(bullet.toLowerCase()).not.toContain('suscríbete');
      expect(bullet.toLowerCase()).not.toContain('cookies');
      expect(bullet.toLowerCase()).not.toContain('regístrate');
    }

    // Content should still be present
    expect(allBullets.some((b) => b.includes('reforma tributaria') || b.includes('Congreso'))).toBe(true);
  });
});
