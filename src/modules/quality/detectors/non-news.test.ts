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
  });
});
