import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ElTiempoScraper } from './eltiempo.js';
import { ElEspectadorScraper } from './elespectador.js';
import { StubScraper } from './stub-scraper.js';

function loadFixture(name: string): string {
  return readFileSync(resolve(process.cwd(), `test/fixtures/${name}`), 'utf-8');
}

describe('ElTiempoScraper', () => {
  const scraper = new ElTiempoScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('eltiempo.com');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('eltiempo-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('gobierno-anuncia-reforma-tributaria-12345');
    expect(urls[1]).toContain('dolar-se-dispara-en-colombia-67890');
    expect(urls[2]).toContain('bogota-inaugura-nueva-linea-metro-11111');
  });

  it('deduplicates URLs', () => {
    const html = `
      <a href="https://www.eltiempo.com/politica/test-article-123">A</a>
      <a href="https://www.eltiempo.com/politica/test-article-123">B</a>
    `;
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(1);
  });

  it('parses article page fixture', () => {
    const html = loadFixture('eltiempo-article.html');
    const parsed = scraper.parseArticle(html, 'https://www.eltiempo.com/politica/test-12345');
    expect(parsed.title).toBe('Gobierno anuncia reforma tributaria para 2026');
    expect(parsed.snippet).toContain('El presidente de Colombia');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-15T10:30:00Z'));
  });
});

describe('ElEspectadorScraper', () => {
  const scraper = new ElEspectadorScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('elespectador.com');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('elespectador-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('nueva-ley-de-educacion-aprobada');
    expect(urls[1]).toContain('banco-central-baja-tasas-interes');
    expect(urls[2]).toContain('seleccion-colombia-clasifica-mundial');
  });

  it('parses article page fixture', () => {
    const html = loadFixture('elespectador-article.html');
    const parsed = scraper.parseArticle(html, 'https://www.elespectador.com/politica/test/');
    expect(parsed.title).toBe('Nueva ley de educación aprobada por el Congreso');
    expect(parsed.snippet).toContain('El Congreso de la República');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-14T08:00:00Z'));
  });
});

describe('StubScraper', () => {
  const scraper = new StubScraper();

  it('has no list page URLs', () => {
    expect(scraper.listPageUrls).toHaveLength(0);
  });

  it('returns empty URLs', () => {
    expect(scraper.extractUrls('<html></html>')).toEqual([]);
  });

  it('returns empty article', () => {
    const parsed = scraper.parseArticle('<html></html>', 'https://example.com');
    expect(parsed.title).toBe('');
    expect(parsed.snippet).toBe('');
    expect(parsed.publishedAt).toBeNull();
  });
});
