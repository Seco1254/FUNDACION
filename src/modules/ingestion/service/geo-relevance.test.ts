import { describe, it, expect } from 'vitest';
import { classifyGeoRelevance, isGeoFilterEnabled } from './geo-relevance.js';

describe('classifyGeoRelevance', () => {
  describe('Tier 1 — local (Colombian signals)', () => {
    it('detects departamento name', () => {
      const result = classifyGeoRelevance(
        'Comunidades del Cauca denuncian amenazas',
        'Líderes sociales en el norte del Cauca reportan intimidaciones.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('Cauca');
    });

    it('detects city name', () => {
      const result = classifyGeoRelevance(
        'Protesta en Bogotá por reforma pensional',
        'Miles de ciudadanos marcharon en la capital.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('Bogotá');
    });

    it('detects "Colombia" as explicit override', () => {
      const result = classifyGeoRelevance(
        'Solidaridad con Palestina desde Colombia',
        'Organizaciones sociales expresan su apoyo.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('Colombia');
    });

    it('detects conflict actor', () => {
      const result = classifyGeoRelevance(
        'ELN declara cese al fuego unilateral',
        'El grupo guerrillero anunció el cese de hostilidades.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('ELN');
    });

    it('detects institution', () => {
      const result = classifyGeoRelevance(
        'JEP emite nuevas sentencias',
        'La jurisdicción especial avanza en casos de verdad.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('JEP');
    });

    it('detects Palestina, Caldas via departamento match', () => {
      const result = classifyGeoRelevance(
        'Palestina, Caldas: nueva inversión en infraestructura',
        'El municipio recibió recursos del gobierno departamental.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('Caldas');
    });
  });

  describe('Tier 2 — regional (Latin American signals)', () => {
    it('detects LatAm country without Colombia mention', () => {
      const result = classifyGeoRelevance(
        'Crisis migratoria en Venezuela se agrava',
        'Millones de personas han abandonado el país.',
      );
      expect(result.tier).toBe('regional');
      expect(result.matchedKeywords).toContain('Venezuela');
    });

    it('detects regional term "América Latina"', () => {
      const result = classifyGeoRelevance(
        'Pueblos indígenas de América Latina exigen respeto',
        'Organizaciones de todo el continente se pronuncian.',
      );
      expect(result.tier).toBe('regional');
      expect(result.matchedKeywords).toContain('América Latina');
    });
  });

  describe('Tier 3 — international (no geographic signal)', () => {
    it('returns international for purely international content', () => {
      const result = classifyGeoRelevance(
        'Crisis humanitaria en Irán',
        'Organizaciones de derechos humanos denuncian la situación.',
      );
      expect(result.tier).toBe('international');
      expect(result.matchedKeywords).toHaveLength(0);
    });

    it('returns international for Gaza without Colombia mention', () => {
      const result = classifyGeoRelevance(
        'Crisis humanitaria en Gaza',
        'La situación se deteriora en la franja.',
      );
      expect(result.tier).toBe('international');
      expect(result.matchedKeywords).toHaveLength(0);
    });

    it('returns international when no geographic signals at all', () => {
      const result = classifyGeoRelevance(
        'Nuevas tecnologías de inteligencia artificial',
        'Avances en procesamiento de lenguaje natural.',
      );
      expect(result.tier).toBe('international');
      expect(result.matchedKeywords).toHaveLength(0);
    });
  });

  describe('priority: local > regional > international', () => {
    it('prefers local over regional when both present', () => {
      const result = classifyGeoRelevance(
        'Venezuela y Colombia firman acuerdo migratorio',
        'Ambos países se comprometen a gestión humanitaria.',
      );
      expect(result.tier).toBe('local');
      expect(result.matchedKeywords).toContain('Colombia');
    });
  });
});

describe('isGeoFilterEnabled', () => {
  it('returns true by default (GEO_FILTER_ENABLED not set to 0)', () => {
    // Default behavior: enabled
    expect(isGeoFilterEnabled()).toBe(true);
  });
});
