import { describe, it, expect } from 'vitest';
import { classifyContent } from './content-classifier.js';

describe('classifyContent', () => {
  // ── institutional_static ──────────────────────────────────────────

  describe('institutional_static detection', () => {
    it('"Quiénes somos" page => institutional_static', () => {
      const result = classifyContent({
        text: 'Razón Pública es una revista digital fundada en 2008. Nuestra misión es promover el debate público informado. Junta directiva: María López, Carlos Pérez.',
        title: 'Quiénes somos - Razón Pública',
        url: 'https://razonpublica.com/quienes-somos/',
      });
      expect(result.content_type).toBe('institutional_static');
      expect(result.score).toBeGreaterThanOrEqual(0.45);
      expect(result.reasons.some((r) => r.includes('quienes_somos'))).toBe(true);
    });

    it('donations page => institutional_static', () => {
      const result = classifyContent({
        text: 'Haz una donación para apoyar el periodismo independiente. Cuenta corriente Bancolombia 123-456. NIT: 900.123.456-7. Da clic aquí para donar.',
        title: 'Donaciones - Apóyanos',
        url: 'https://example.com/donaciones',
      });
      expect(result.content_type).toBe('institutional_static');
      expect(result.score).toBeGreaterThanOrEqual(0.45);
    });

    it('about page with team bios => institutional_static', () => {
      const result = classifyContent({
        text: 'Nuestro equipo está formado por periodistas y académicos dedicados. Director ejecutivo: Juan Pérez. Desde 2010 trabajamos en la promoción del periodismo investigativo.',
        title: 'Sobre nosotros',
        url: 'https://example.com/about',
      });
      expect(result.content_type).toBe('institutional_static');
      expect(result.score).toBeGreaterThanOrEqual(0.45);
    });

    it('title with "acerca de" => institutional_static', () => {
      const result = classifyContent({
        text: 'Razón social: Fundación para el Debate Público. Junta directiva. Fundada en 2005.',
        title: 'Acerca de la fundación',
        url: 'https://example.com/historia',
      });
      expect(result.content_type).toBe('institutional_static');
    });

    it('URL /mision path => high static score', () => {
      const result = classifyContent({
        text: 'Nuestra misión es promover el debate informado. Desde 2008 dedicamos nuestros esfuerzos.',
        title: 'Misión institucional',
        url: 'https://example.com/mision',
      });
      expect(result.content_type).toBe('institutional_static');
    });
  });

  // ── institutional (convocatoria/seminario) ────────────────────────

  describe('institutional (convocatoria) detection', () => {
    it('convocatoria with zoom link => institutional', () => {
      const result = classifyContent({
        text: 'Convocatoria abierta para el seminario de periodismo. Inscripciones abiertas hasta el 15 de marzo. Enlace de zoom: https://zoom.us/meeting/123. Fecha límite de inscripción: 10 de marzo.',
        title: 'Seminario de periodismo digital',
        url: 'https://example.com/seminario-periodismo',
      });
      expect(result.content_type).toBe('institutional');
      expect(result.score).toBeGreaterThanOrEqual(0.5);
    });

    it('seminar announcement without news => institutional', () => {
      const result = classifyContent(
        'Convocatoria abierta para el seminario internacional de derechos humanos. Inscripciones abiertas hasta el 15 de marzo. Formulario de inscripción disponible. Certificado de asistencia para todos los participantes.',
      );
      expect(result.content_type).toBe('institutional');
    });
  });

  // ── news detection ────────────────────────────────────────────────

  describe('news detection', () => {
    it('news about a seminar (with reporting verbs) => news', () => {
      const result = classifyContent({
        text: 'El gobierno anunció un seminario sobre reforma tributaria. El ministro señaló que la inscripción será gratuita. El presidente declaró que esperan más de 500 asistentes. Los organizadores confirmaron la fecha.',
        title: 'Gobierno anuncia seminario sobre reforma tributaria',
        url: 'https://eltiempo.com/politica/seminario-reforma',
      });
      expect(result.content_type).toBe('news');
    });

    it('standard news article => news', () => {
      const result = classifyContent({
        text: 'El Congreso aprobó la reforma tributaria tras intensas negociaciones. La oposición criticó varios artículos del proyecto. El presidente señaló que la reforma beneficiará a los más vulnerables.',
        title: 'Congreso aprueba reforma tributaria',
        url: 'https://elespectador.com/politica/congreso-aprueba-reforma',
      });
      expect(result.content_type).toBe('news');
      expect(result.score).toBeLessThan(0.45);
    });

    it('crime news => news', () => {
      const result = classifyContent(
        'Las autoridades capturaron a tres sospechosos. El fiscal denunció la presencia de una red criminal. Los investigadores revelaron nuevas pruebas.',
      );
      expect(result.content_type).toBe('news');
    });
  });

  // ── opinion ───────────────────────────────────────────────────────

  describe('opinion detection', () => {
    it('editorial column => opinion', () => {
      const result = classifyContent(
        'Columna de opinión: La crisis del sistema judicial colombiano. Editorial sobre los retos actuales.',
      );
      expect(result.content_type).toBe('opinion');
    });
  });

  // ── backward compatibility ────────────────────────────────────────

  describe('backward compatibility', () => {
    it('accepts plain string (no title/url)', () => {
      const result = classifyContent('Noticia simple sin contexto adicional.');
      expect(result.content_type).toBe('news');
      expect(result.score).toBe(0);
    });

    it('empty string => unknown', () => {
      const result = classifyContent('');
      expect(result.content_type).toBe('unknown');
    });

    it('object input with only text => works', () => {
      const result = classifyContent({ text: 'Texto simple.' });
      expect(result.content_type).toBe('news');
    });
  });
});
