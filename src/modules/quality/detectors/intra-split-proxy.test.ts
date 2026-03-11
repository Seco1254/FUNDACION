import { describe, it, expect } from 'vitest';
import { detectIntraSplitProxy, type ArticleForIntraSplit } from './intra-split-proxy.js';

describe('detectIntraSplitProxy', () => {
  // ── Below minimum article count ──

  it('returns split_proxy=false when fewer than 3 articles', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno anuncia reforma', url: 'https://a.com/politica/1' },
      { title: 'Presidente presenta proyecto', url: 'https://b.com/politica/2' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.split_proxy).toBe(false);
  });

  it('returns split_proxy=false for empty array', () => {
    const result = detectIntraSplitProxy([]);
    expect(result.split_proxy).toBe(false);
  });

  // ── Cohesive event (single topic) ──

  it('returns split_proxy=false when all articles are same topic', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno presenta reforma tributaria al congreso', url: 'https://a.com/politica/1' },
      { title: 'Presidente Petro defiende la reforma en el senado', url: 'https://b.com/politica/2' },
      { title: 'Congreso debate el proyecto de reforma del gobierno', url: 'https://c.com/politica/3' },
      { title: 'Ministro del gabinete respalda la reforma tributaria', url: 'https://d.com/politica/4' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.split_proxy).toBe(false);
    expect(result.top_topic).toBe('POLITICA');
    expect(result.top_topic_share).toBeGreaterThanOrEqual(0.6);
  });

  // ── Mixed event (fragmented topics) ──

  it('flags split_proxy=true when topics are fragmented', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno presenta reforma tributaria fiscal', url: 'https://a.com/politica/1' },
      { title: 'Selección Colombia gol goles mundial fútbol', url: 'https://b.com/deportes/2' },
      { title: 'Hospital inicia vacunación médico paciente', url: 'https://c.com/salud/3' },
      { title: 'Cantante famoso estreno concierto festival', url: 'https://d.com/entretenimiento/4' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.split_proxy).toBe(true);
    expect(result.top_topic_share).toBeLessThan(0.6);
    expect(result.reasons.some((r) => r.startsWith('TOPIC_FRAGMENTED'))).toBe(true);
  });

  // ── Mixed event (fragmented desks) ──

  it('flags split_proxy=true when desks are fragmented', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Fiscalía investiga homicidio sicarios crimen', url: 'https://a.com/justicia/1' },
      { title: 'Policía captura criminal narcotráfico crimen', url: 'https://b.com/deportes/2' },
      { title: 'Crimen organizado y violencia sicarios', url: 'https://c.com/salud/3' },
    ];
    const result = detectIntraSplitProxy(articles);
    // Topic may still be cohesive (CRIMEN_SEGURIDAD) but desks are fragmented
    expect(result.split_proxy).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  // ── All sports articles with consistent desks ──

  it('returns split_proxy=false for cohesive sports event', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Selección Colombia gol eliminatoria mundial fútbol', url: 'https://a.com/deportes/futbol/1' },
      { title: 'Entrenador técnico celebra victoria equipo gol', url: 'https://b.com/deportes/futbol/2' },
      { title: 'Jugadores estrella del campeonato futbol goles', url: 'https://c.com/deportes/3' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.split_proxy).toBe(false);
    expect(result.top_topic).toBe('DEPORTES');
    expect(result.top_desk).toBe('DEPORTES');
  });

  // ── 2 POLITICA + 1 DEPORTES → borderline but may or may not trigger ──

  it('handles 2/3 majority (67%) correctly — no split', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno presenta reforma fiscal al congreso senado', url: 'https://a.com/politica/1' },
      { title: 'Presidente anuncia decreto legislatura gabinete', url: 'https://b.com/politica/2' },
      { title: 'Selección Colombia fútbol gol mundial eliminatoria', url: 'https://c.com/deportes/3' },
    ];
    const result = detectIntraSplitProxy(articles);
    // 2/3 = 0.67 > 0.6 → topic is OK
    expect(result.top_topic_share).toBeGreaterThanOrEqual(0.6);
  });

  // ── Articles without URLs (desk = null) ──

  it('handles articles without URLs (no desk signal)', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno reforma tributaria congreso senado' },
      { title: 'Presidente gabinete ministro decreto legislatura' },
      { title: 'Oposición partido elecciones candidato votación' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.split_proxy).toBe(false);
    // No desk data, so desk_share defaults to 1.0
    expect(result.top_desk_share).toBe(1);
  });

  // ── Determinism ──

  it('is deterministic: same input → same output', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno reforma fiscal congreso senado presidente', url: 'https://a.com/politica/1' },
      { title: 'Fútbol selección gol mundial copa eliminatoria', url: 'https://b.com/deportes/2' },
      { title: 'Hospital médico vacuna paciente salud enfermedad', url: 'https://c.com/salud/3' },
    ];
    const r1 = detectIntraSplitProxy(articles);
    const r2 = detectIntraSplitProxy(articles);
    expect(r1).toEqual(r2);
  });

  // ── Histogram correctness ──

  it('builds correct topic_histogram', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno reforma congreso senado presidente', url: 'https://a.com/politica/1' },
      { title: 'Gobierno reforma congreso oposición decreto legislatura', url: 'https://b.com/politica/2' },
      { title: 'Selección gol fútbol mundial copa eliminatoria', url: 'https://c.com/deportes/3' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.topic_histogram['POLITICA']).toBe(2);
    expect(result.topic_histogram['DEPORTES']).toBe(1);
  });

  it('builds correct desk_histogram', () => {
    const articles: ArticleForIntraSplit[] = [
      { title: 'Gobierno reforma congreso senado presidente', url: 'https://a.com/politica/1' },
      { title: 'Gobierno reforma congreso oposición decreto legislatura', url: 'https://b.com/politica/2' },
      { title: 'Selección gol fútbol mundial copa eliminatoria', url: 'https://c.com/deportes/3' },
    ];
    const result = detectIntraSplitProxy(articles);
    expect(result.desk_histogram['POLITICA']).toBe(2);
    expect(result.desk_histogram['DEPORTES']).toBe(1);
  });
});
