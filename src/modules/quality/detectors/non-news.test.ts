import { describe, it, expect } from 'vitest';
import { classifyNonNews } from './non-news.js';

describe('classifyNonNews', () => {
  describe('institutional pages', () => {
    it('blocks "Quiénes somos"', () => {
      const r = classifyNonNews('Quiénes somos');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('institutional_exact');
    });

    it('blocks "NUESTROS SERVICIOS"', () => {
      const r = classifyNonNews('NUESTROS SERVICIOS');
      expect(r.isNonNews).toBe(true);
    });

    it('blocks "Contáctenos"', () => {
      expect(classifyNonNews('Contáctenos').isNonNews).toBe(true);
    });

    it('blocks privacy policies', () => {
      const r = classifyNonNews('Política de protección y tratamiento de datos personales');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('institutional_contains');
    });

    it('blocks terms and conditions', () => {
      expect(classifyNonNews('Términos y condiciones de uso').isNonNews).toBe(true);
    });

    // P0.1: institutional pages with media-name suffixes
    it('blocks "Quiénes somos - Razón Pública"', () => {
      const r = classifyNonNews('Quiénes somos - Razón Pública');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('institutional_exact');
    });

    it('blocks "Quiénes somos | El Tiempo"', () => {
      expect(classifyNonNews('Quiénes somos | El Tiempo').isNonNews).toBe(true);
    });

    it('blocks "Quiénes Somos – FLIP"', () => {
      expect(classifyNonNews('Quiénes Somos – FLIP').isNonNews).toBe(true);
    });

    it('blocks "Contáctenos - La Silla Vacía"', () => {
      expect(classifyNonNews('Contáctenos - La Silla Vacía').isNonNews).toBe(true);
    });

    it('blocks "Aviso legal | Semana"', () => {
      expect(classifyNonNews('Aviso legal | Semana').isNonNews).toBe(true);
    });

    it('blocks "Mapa del sitio: El Espectador"', () => {
      expect(classifyNonNews('Mapa del sitio: El Espectador').isNonNews).toBe(true);
    });
  });

  describe('podcasts', () => {
    it('blocks "PÓDCAST | Cuando los hijos se vuelven armas..."', () => {
      const r = classifyNonNews('PÓDCAST | Cuando los hijos se vuelven armas...');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('podcast');
    });

    it('blocks "PÓDCAST | Cantos que curan..."', () => {
      expect(classifyNonNews('PÓDCAST | Cantos que curan...').isNonNews).toBe(true);
    });

    it('blocks "Podcast: entrevista con..."', () => {
      expect(classifyNonNews('Podcast: entrevista con el ministro').isNonNews).toBe(true);
    });

    // P1: expanded serial/episode patterns
    it('blocks "Ep. 5 — La crisis económica"', () => {
      expect(classifyNonNews('Ep. 5 — La crisis económica').isNonNews).toBe(true);
    });

    it('blocks "Ep12 El otro lado"', () => {
      expect(classifyNonNews('Ep12 El otro lado').isNonNews).toBe(true);
    });

    it('blocks "Episodio 3: Los actores del conflicto"', () => {
      expect(classifyNonNews('Episodio 3: Los actores del conflicto').isNonNews).toBe(true);
    });

    it('blocks "Capítulo 8. El desenlace"', () => {
      expect(classifyNonNews('Capítulo 8. El desenlace').isNonNews).toBe(true);
    });

    it('blocks "T2E5 Entrevista con el senador"', () => {
      expect(classifyNonNews('T2E5 Entrevista con el senador').isNonNews).toBe(true);
    });

    it('blocks "Temporada 3: Las reformas"', () => {
      expect(classifyNonNews('Temporada 3: Las reformas').isNonNews).toBe(true);
    });

    it('blocks "Episode 10 – Special report"', () => {
      expect(classifyNonNews('Episode 10 – Special report').isNonNews).toBe(true);
    });
  });

  describe('digest/index pages', () => {
    it('blocks "EDICIÓN DEL 16 DE FEBRERO AL 22 DE FEBRERO DEL 2026"', () => {
      const r = classifyNonNews('EDICIÓN DEL 16 DE FEBRERO AL 22 DE FEBRERO DEL 2026');
      expect(r.isNonNews).toBe(true);
    });

    it('blocks "Resumen semanal de noticias"', () => {
      expect(classifyNonNews('Resumen semanal de noticias').isNonNews).toBe(true);
    });

    it('blocks "Boletín semanal"', () => {
      expect(classifyNonNews('Boletín semanal').isNonNews).toBe(true);
    });
  });

  describe('soft content', () => {
    it('blocks "Neurótica Anónima"', () => {
      expect(classifyNonNews('Neurótica Anónima').isNonNews).toBe(true);
    });

    it('blocks "Horóscopo del día"', () => {
      expect(classifyNonNews('Horóscopo del día').isNonNews).toBe(true);
    });
  });

  describe('real news passes through', () => {
    it('allows "Reforma tributaria aprobada en segundo debate"', () => {
      expect(classifyNonNews('Reforma tributaria aprobada en segundo debate').isNonNews).toBe(false);
    });

    it('allows "Protestas en Bogotá por aumento de transporte"', () => {
      expect(classifyNonNews('Protestas en Bogotá por aumento de transporte').isNonNews).toBe(false);
    });

    it('allows "Colombia firma acuerdo comercial con Japón"', () => {
      expect(classifyNonNews('Colombia firma acuerdo comercial con Japón').isNonNews).toBe(false);
    });

    it('allows "Petro anuncia nueva política de seguridad"', () => {
      expect(classifyNonNews('Petro anuncia nueva política de seguridad').isNonNews).toBe(false);
    });

    it('allows "La guerra desregulada"', () => {
      expect(classifyNonNews('LA GUERRA DESREGULADA').isNonNews).toBe(false);
    });

    it('allows empty/null headline', () => {
      expect(classifyNonNews('').isNonNews).toBe(false);
    });

    // Regression: real news with words that could false-positive
    it('allows "Nuevo episodio de violencia en Cauca"', () => {
      expect(classifyNonNews('Nuevo episodio de violencia en Cauca').isNonNews).toBe(false);
    });

    it('allows "Capítulo del acuerdo de paz avanza en el Congreso"', () => {
      expect(classifyNonNews('Capítulo del acuerdo de paz avanza en el Congreso').isNonNews).toBe(false);
    });

    it('allows "El servicio de salud colapsa en tres departamentos"', () => {
      expect(classifyNonNews('El servicio de salud colapsa en tres departamentos').isNonNews).toBe(false);
    });

    it('allows "Quiénes son los responsables del colapso vial"', () => {
      expect(classifyNonNews('Quiénes son los responsables del colapso vial').isNonNews).toBe(false);
    });
  });
});
