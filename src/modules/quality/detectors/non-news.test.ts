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

  describe('author profiles', () => {
    it('blocks "Juan Pérez: Noticias, Fotos y Videos de Colombia"', () => {
      const r = classifyNonNews('Juan Pérez: Noticias, Fotos y Videos de Colombia');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('author_profile');
    });

    it('blocks "María López: Noticias, Fotos y Vídeos"', () => {
      expect(classifyNonNews('María López: Noticias, Fotos y Vídeos').isNonNews).toBe(true);
    });

    it('blocks "Autor: Carlos García"', () => {
      expect(classifyNonNews('Autor: Carlos García').isNonNews).toBe(true);
    });

    it('blocks "Perfil de autor"', () => {
      expect(classifyNonNews('Perfil de autor').isNonNews).toBe(true);
    });

    it('blocks "Perfil de columnista"', () => {
      expect(classifyNonNews('Perfil de columnista').isNonNews).toBe(true);
    });

    it('blocks "Columnistas"', () => {
      expect(classifyNonNews('Columnistas').isNonNews).toBe(true);
    });

    it('blocks "Nuestros columnistas"', () => {
      expect(classifyNonNews('Nuestros columnistas').isNonNews).toBe(true);
    });

    it('blocks "Equipo editorial"', () => {
      expect(classifyNonNews('Equipo editorial').isNonNews).toBe(true);
    });

    it('blocks "Índice de autores"', () => {
      expect(classifyNonNews('Índice de autores').isNonNews).toBe(true);
    });

    it('allows "Autor de masacre condenado a 40 años"', () => {
      expect(classifyNonNews('Autor de masacre condenado a 40 años').isNonNews).toBe(false);
    });
  });

  describe('navigation / e-commerce / archive pages', () => {
    it('blocks "Carrito"', () => {
      const r = classifyNonNews('Carrito');
      expect(r.isNonNews).toBe(true);
      expect(r.reason).toBe('navigation_page');
    });

    it('blocks "Carrito de compras"', () => {
      expect(classifyNonNews('Carrito de compras').isNonNews).toBe(true);
    });

    it('blocks "Mi carrito de compras"', () => {
      expect(classifyNonNews('Mi carrito de compras').isNonNews).toBe(true);
    });

    it('blocks "Productos archivo"', () => {
      expect(classifyNonNews('Productos archivo').isNonNews).toBe(true);
    });

    it('blocks "Productos"', () => {
      expect(classifyNonNews('Productos').isNonNews).toBe(true);
    });

    it('blocks "Obras de arte"', () => {
      expect(classifyNonNews('Obras de arte').isNonNews).toBe(true);
    });

    it('blocks "Archivo"', () => {
      expect(classifyNonNews('Archivo').isNonNews).toBe(true);
    });

    it('blocks "Categoría: Política"', () => {
      expect(classifyNonNews('Categoría: Política').isNonNews).toBe(true);
    });

    it('blocks "Página no encontrada"', () => {
      expect(classifyNonNews('Página no encontrada').isNonNews).toBe(true);
    });

    it('blocks "Error 404 - No encontrado"', () => {
      expect(classifyNonNews('Error 404 - No encontrado').isNonNews).toBe(true);
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

    // Regression: headlines with navigation-like words in news context
    it('allows "Productos colombianos conquistan mercado europeo"', () => {
      expect(classifyNonNews('Productos colombianos conquistan mercado europeo').isNonNews).toBe(false);
    });

    it('allows "Archivo de la verdad revela nuevos testimonios"', () => {
      expect(classifyNonNews('Archivo de la verdad revela nuevos testimonios').isNonNews).toBe(false);
    });

    it('allows "Obras de arte robadas recuperadas por la policía"', () => {
      expect(classifyNonNews('Obras de arte robadas recuperadas por la policía').isNonNews).toBe(false);
    });
  });
});
