import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to mock config before importing sanitize
vi.mock('./config.js', () => ({
  TEXT_SANITIZER_ENABLED: true,
  DEBUG_TEXT_SANITIZER: false,
  TEXT_SANITIZER_NUMERIC_DENSITY_THRESHOLD: 0.35,
  TEXT_SANITIZER_MAX_NOISE_LINE_LEN: 80,
  TEXT_SANITIZER_DEDUP_ENABLED: true,
  TEXT_SANITIZER_DEDUP_JACCARD: 0.85,
  TEXT_SANITIZER_MIN_ALPHA_CHARS: 12,
}));

import { sanitizeText, SanitizeResult } from './sanitize.js';

describe('sanitizeText', () => {
  describe('boilerplate removal', () => {
    it('removes lines with newsletter/cookies/registro patterns', () => {
      const text = [
        'El gobierno aprobó una reforma tributaria importante.',
        'Suscríbete a nuestro boletín para recibir las últimas noticias.',
        'La medida establece un aumento del 15% en impuestos.',
        'Acepta cookies para continuar navegando.',
        'Los gremios económicos expresaron preocupación.',
        'Regístrate gratis y accede a contenido exclusivo.',
      ].join('\n');

      const result = sanitizeText({ text });

      expect(result.cleaned_text).toContain('reforma tributaria');
      expect(result.cleaned_text).toContain('aumento del 15%');
      expect(result.cleaned_text).toContain('gremios económicos');
      expect(result.cleaned_text).not.toContain('Suscríbete');
      expect(result.cleaned_text).not.toContain('cookies');
      expect(result.cleaned_text).not.toContain('Regístrate');

      const boilerplateRemovals = result.removed.filter((r) => r.kind === 'boilerplate');
      expect(boilerplateRemovals.length).toBe(3);
    });

    it('removes publicidad and contenido patrocinado', () => {
      const text = [
        'La inflación bajó al 5.2% interanual en Colombia.',
        'Publicidad: ofertas exclusivas para ti.',
        'El Banco de la República ajustó las tasas.',
        'Contenido patrocinado por empresa X.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).not.toContain('Publicidad');
      expect(result.cleaned_text).not.toContain('patrocinado');
      expect(result.cleaned_text).toContain('inflación');
    });

    it('removes block headers and the next 2 lines', () => {
      const text = [
        'La reforma fue aprobada por el Congreso.',
        'Te puede interesar',
        'Artículo relacionado uno',
        'Artículo relacionado dos',
        'El presidente celebró la aprobación de la medida.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).toContain('reforma fue aprobada');
      expect(result.cleaned_text).toContain('presidente celebró');
      expect(result.cleaned_text).not.toContain('puede interesar');
      expect(result.cleaned_text).not.toContain('relacionado uno');
      expect(result.cleaned_text).not.toContain('relacionado dos');
    });

    it('handles "seguir leyendo" and "leer más"', () => {
      const text = [
        'Tres departamentos reportaron inundaciones graves en la región.',
        'Seguir leyendo para más detalles del artículo.',
        'Leer más sobre esta noticia en nuestra app.',
        'Las autoridades activaron los protocolos de emergencia.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).not.toContain('Seguir leyendo');
      expect(result.cleaned_text).not.toContain('Leer más');
      expect(result.cleaned_text).toContain('inundaciones');
    });
  });

  describe('date/numeric noise removal', () => {
    it('removes lines with high digit density and no context', () => {
      const text = [
        'El Congreso aprobó la reforma con 87 votos a favor.',
        '19022026 2148',
        '2026-02-19 21:48',
        '01/02/2026 14:33',
        'Los recursos se destinarán a educación y salud.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).toContain('Congreso aprobó');
      expect(result.cleaned_text).toContain('educación y salud');
      expect(result.cleaned_text).not.toContain('19022026');
      expect(result.cleaned_text).not.toContain('2026-02-19');

      const noiseRemovals = result.removed.filter((r) => r.kind === 'date_noise');
      expect(noiseRemovals.length).toBeGreaterThanOrEqual(2);
    });

    it('keeps lines with numbers in context (e.g. "87 votos")', () => {
      const text = 'El proyecto fue aprobado con 87 votos a favor y 23 en contra.';
      const result = sanitizeText({ text });
      expect(result.cleaned_text).toContain('87 votos');
    });
  });

  describe('dedup (repeat removal)', () => {
    it('removes exact duplicate sentences', () => {
      const sentence = 'El gobierno colombiano anunció nuevas medidas económicas para el país.';
      const text = [sentence, sentence, sentence].join(' ');

      const result = sanitizeText({ text });
      // Count how many times the sentence appears
      const matches = result.cleaned_text.match(/El gobierno colombiano/g);
      expect(matches?.length).toBe(1);

      const dedupRemovals = result.removed.filter((r) => r.kind === 'repeat_dedup');
      expect(dedupRemovals.length).toBe(2);
    });

    it('removes near-duplicate sentences above Jaccard threshold', () => {
      // Two long sentences that differ only in the last word — high 5-gram shingle overlap
      const text = [
        'El gobierno colombiano presentó un ambicioso plan de reforma económica para mejorar significativamente la situación del sector.',
        'El gobierno colombiano presentó un ambicioso plan de reforma económica para mejorar significativamente la situación del empleo.',
        'La reforma tributaria fue discutida en el Congreso de la República por los senadores.',
      ].join(' ');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).toContain('El gobierno colombiano');
      expect(result.cleaned_text).toContain('reforma tributaria');

      const dedupRemovals = result.removed.filter((r) => r.kind === 'repeat_dedup');
      expect(dedupRemovals.length).toBe(1);
    });

    it('keeps distinct sentences', () => {
      const text = [
        'La inflación bajó al 5.2% interanual en Colombia.',
        'El desempleo se mantuvo estable durante el trimestre anterior.',
        'Las exportaciones crecieron un 12% respecto al año pasado en la región.',
      ].join(' ');

      const result = sanitizeText({ text });
      expect(result.removed.filter((r) => r.kind === 'repeat_dedup')).toHaveLength(0);
    });
  });

  describe('navigation line removal', () => {
    it('removes breadcrumb-style navigation', () => {
      const text = [
        'Inicio > Colombia > Economía > Reforma',
        'El gobierno aprobó la reforma tributaria con apoyo mayoritario.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).not.toContain('Inicio >');
      expect(result.cleaned_text).toContain('reforma tributaria');
    });

    it('removes "Tags:" lines', () => {
      const text = [
        'Las autoridades activaron los protocolos de emergencia.',
        'Tags: colombia, reforma, economía',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).not.toContain('Tags:');
    });
  });

  describe('short line removal', () => {
    it('removes very short lines with few alpha chars', () => {
      const text = [
        'Las exportaciones crecieron un 12% respecto al año pasado.',
        '***',
        '---',
        '...',
        'El banco central ajustó las tasas de interés ayer.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).not.toContain('***');
      expect(result.cleaned_text).not.toContain('---');
    });

    it('keeps short lines with enough alpha content', () => {
      const text = [
        'La reforma fue aprobada.',
        'Bogotá, Colombia.',
      ].join('\n');

      const result = sanitizeText({ text });
      // "La reforma fue aprobada." has 20 alpha chars → keep
      expect(result.cleaned_text).toContain('reforma fue aprobada');
    });
  });

  describe('stats and metadata', () => {
    it('returns correct stats', () => {
      const text = [
        'Línea uno de contenido noticioso sobre la reforma.',
        'Newsletter: suscríbete aquí.',
        'Línea tres sobre la economía colombiana actual.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.stats.lines_before).toBe(3);
      expect(result.stats.removed_lines).toBeGreaterThanOrEqual(1);
      expect(result.stats.chars_before).toBe(text.length);
      expect(result.stats.chars_after).toBeLessThan(text.length);
    });

    it('tracks ngram_hashes_removed in fingerprints', () => {
      const sentence = 'El gobierno colombiano anunció nuevas medidas económicas para el país.';
      const text = [sentence, sentence].join(' ');

      const result = sanitizeText({ text });
      expect(result.fingerprints?.ngram_hashes_removed).toBe(1);
    });
  });

  describe('pass-through behavior', () => {
    it('preserves clean news text', () => {
      const text = [
        'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor.',
        'La medida establece un aumento del 15% en la recaudación fiscal.',
        'Los gremios económicos expresaron su preocupación por el impacto.',
        'El ministro de Hacienda defendió la iniciativa ante los medios.',
      ].join('\n');

      const result = sanitizeText({ text });
      expect(result.cleaned_text).toContain('Congreso de la República');
      expect(result.cleaned_text).toContain('medida establece');
      expect(result.cleaned_text).toContain('gremios económicos');
      expect(result.cleaned_text).toContain('ministro de Hacienda');
      expect(result.stats.removed_lines).toBe(0);
    });

    it('preserves text with >= 800 chars when cleaning is minimal', () => {
      const lines = [];
      for (let i = 0; i < 10; i++) {
        lines.push(`Oración informativa número ${i + 1} sobre la política económica colombiana que tiene importancia.`);
      }
      const text = lines.join('\n');
      expect(text.length).toBeGreaterThan(800);

      const result = sanitizeText({ text });
      expect(result.cleaned_text.length).toBeGreaterThanOrEqual(800);
    });
  });

  describe('combined real-world scenario', () => {
    it('cleans a realistic article with mixed boilerplate', () => {
      const text = [
        'Inicio > Colombia > Política',
        '',
        'Reforma tributaria: el gobierno busca recaudar 18 billones adicionales',
        '',
        'El Congreso de la República aprobó la reforma tributaria con 87 votos a favor y 23 en contra en la plenaria.',
        'La medida establece un aumento del 15 por ciento en la recaudación fiscal para el próximo año.',
        'Los gremios económicos del país expresaron su preocupación por el impacto en la competitividad.',
        'Según el ministro de Hacienda, los recursos se destinarán a programas de educación y salud.',
        '',
        '19022026 2148',
        '',
        'Suscríbete a nuestro newsletter',
        'Recibe noticias cada día en tu correo',
        'Ingresa tu email aquí',
        '',
        'Te puede interesar',
        'Artículo sobre otro tema',
        'Otra noticia relacionada',
        '',
        'Tags: reforma, tributaria, colombia',
        '***',
      ].join('\n');

      const result = sanitizeText({ text, source: { media_key: 'eltiempo', url: 'https://eltiempo.com/test' } });

      // News content preserved
      expect(result.cleaned_text).toContain('Congreso de la República');
      expect(result.cleaned_text).toContain('reforma tributaria');
      expect(result.cleaned_text).toContain('ministro de Hacienda');

      // Boilerplate removed
      expect(result.cleaned_text).not.toContain('Suscríbete');
      expect(result.cleaned_text).not.toContain('newsletter');
      expect(result.cleaned_text).not.toContain('Te puede interesar');

      // Nav removed
      expect(result.cleaned_text).not.toContain('Inicio >');
      expect(result.cleaned_text).not.toContain('Tags:');

      // Noise removed
      expect(result.cleaned_text).not.toContain('19022026');

      // Stats are reasonable
      expect(result.stats.removed_lines).toBeGreaterThanOrEqual(5);
    });
  });
});
