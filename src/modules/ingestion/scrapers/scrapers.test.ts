import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { ElTiempoScraper } from './eltiempo.js';
import { ElEspectadorScraper } from './elespectador.js';
import { RazonPublicaScraper } from './razon-publica.js';
import { FlipScraper } from './flip.js';
import { ConsonanteScraper } from './consonante.js';
import { OecScraper } from './oec.js';
import { AscolbiScraper } from './ascolbi.js';
import { AciurScraper } from './aciur.js';
import { StubScraper } from './stub-scraper.js';
import { getScraperForMedia } from './registry.js';

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

describe('RazonPublicaScraper', () => {
  const scraper = new RazonPublicaScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('razonpublica.com');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('razon-publica-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('reforma-pensional-impacto-trabajadores-colombianos');
    expect(urls[1]).toContain('crisis-climatica-colombia-retos-politica-ambiental');
    expect(urls[2]).toContain('negociaciones-paz-eln-avances-obstaculos');
  });

  it('excludes category, tag, and author URLs', () => {
    const html = loadFixture('razon-publica-list.html');
    const urls = scraper.extractUrls(html);
    for (const url of urls) {
      expect(url).not.toContain('/categoria/');
      expect(url).not.toContain('/tag/');
      expect(url).not.toContain('/author/');
    }
  });

  it('parses article page fixture', () => {
    const html = loadFixture('razon-publica-article.html');
    const parsed = scraper.parseArticle(html, 'https://razonpublica.com/reforma-pensional-impacto-trabajadores-colombianos/');
    expect(parsed.title).toBe('La reforma pensional y su impacto en los trabajadores colombianos');
    expect(parsed.snippet).toContain('reforma pensional');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-10T14:00:00Z'));
  });
});

describe('FlipScraper', () => {
  const scraper = new FlipScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('flip.org.co');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('flip-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('flip-rechaza-agresion-periodistas-cauca');
    expect(urls[1]).toContain('libertad-prensa-colombia-informe-semestral-2026');
    expect(urls[2]).toContain('acoso-judicial-contra-medios-independientes');
  });

  it('parses article page fixture', () => {
    const html = loadFixture('flip-article.html');
    const parsed = scraper.parseArticle(html, 'https://flip.org.co/pronunciamientos/flip-rechaza-agresion-periodistas-cauca');
    expect(parsed.title).toBe('FLIP rechaza agresión contra periodistas en el Cauca');
    expect(parsed.snippet).toContain('Fundación para la Libertad de Prensa');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-12T09:15:00Z'));
  });
});

describe('ConsonanteScraper', () => {
  const scraper = new ConsonanteScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('consonante.org');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('consonante-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('acueducto-comunitario-tado-choco-resistencia');
    expect(urls[1]).toContain('mujeres-lideresas-san-vicente-caguan-transforman-region');
    expect(urls[2]).toContain('jovenes-carmen-atrato-rescatan-tradiciones-ancestrales');
  });

  it('parses article page fixture', () => {
    const html = loadFixture('consonante-article.html');
    const parsed = scraper.parseArticle(html, 'https://consonante.org/noticia/acueducto-comunitario-tado-choco-resistencia/');
    expect(parsed.title).toBe('El acueducto comunitario de Tadó: una historia de resistencia');
    expect(parsed.snippet).toContain('Tadó, Chocó');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-01-28T11:00:00Z'));
  });
});

describe('OecScraper', () => {
  const scraper = new OecScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('caroycuervo.gov.co');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('oec-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('cenedic-2024-resultados-censo-editorial');
    expect(urls[1]).toContain('editoriales-independientes-colombianas-caracterizacion');
    expect(urls[2]).toContain('feria-libro-bogota-2026-participacion-oec');
  });

  it('parses article page fixture', () => {
    const html = loadFixture('oec-article.html');
    const parsed = scraper.parseArticle(html, 'https://oec.caroycuervo.gov.co/noticias/cenedic-2024-resultados-censo-editorial');
    expect(parsed.title).toBe('CENEDIC 2024: resultados del censo editorial colombiano');
    expect(parsed.snippet).toContain('Censo Nacional de Editoriales');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-05T16:30:00Z'));
  });
});

describe('AscolbiScraper', () => {
  const scraper = new AscolbiScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('ascolbi.org');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('ascolbi-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('bibliotecas-publicas-colombia-desarrollo-sostenible');
    expect(urls[1]).toContain('rol-bibliotecologos-era-digital-transformacion');
    expect(urls[2]).toContain('acceso-informacion-comunidades-rurales-retos');
  });

  it('parses article page fixture', () => {
    const html = loadFixture('ascolbi-article.html');
    const parsed = scraper.parseArticle(html, 'https://www.ascolbi.org/publicaciones/blog/bibliotecas-publicas-colombia-desarrollo-sostenible');
    expect(parsed.title).toBe('Las bibliotecas públicas en Colombia y el desarrollo sostenible');
    expect(parsed.snippet).toContain('bibliotecas públicas colombianas');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-01-20T10:00:00Z'));
  });
});

describe('AciurScraper', () => {
  const scraper = new AciurScraper();

  it('has list page URL', () => {
    expect(scraper.listPageUrls).toHaveLength(1);
    expect(scraper.listPageUrls[0]).toContain('aciur.net');
  });

  it('extracts 3 article URLs from list page fixture', () => {
    const html = loadFixture('aciur-list.html');
    const urls = scraper.extractUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toContain('seminario-teoria-urbana-latinoamericana-convocatoria');
    expect(urls[1]).toContain('investigacion-urbana-colombia-politicas-vivienda');
    expect(urls[2]).toContain('notas-criticas-ordenamiento-territorial-municipios');
  });

  it('excludes category and tag taxonomy URLs', () => {
    const html = loadFixture('aciur-list.html');
    const urls = scraper.extractUrls(html);
    for (const url of urls) {
      expect(url).not.toContain('categorias-noticias');
      expect(url).not.toContain('etiquetas-noticias');
    }
  });

  it('parses article page fixture', () => {
    const html = loadFixture('aciur-article.html');
    const parsed = scraper.parseArticle(html, 'https://aciur.net/noticias-y-eventos/investigacion-urbana-colombia-politicas-vivienda/');
    expect(parsed.title).toBe('Investigación urbana en Colombia: políticas de vivienda');
    expect(parsed.snippet).toContain('políticas de vivienda');
    expect(parsed.snippet.length).toBeGreaterThan(80);
    expect(parsed.publishedAt).toEqual(new Date('2026-02-01T08:45:00Z'));
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

describe('Registry', () => {
  it('returns real scraper for each registered media key', () => {
    const keys = ['eltiempo', 'elespectador', 'razon_publica', 'flip', 'consonante', 'oec', 'ascolbi', 'aciur'];
    for (const key of keys) {
      const scraper = getScraperForMedia(key);
      expect(scraper.listPageUrls.length).toBeGreaterThan(0);
    }
  });

  it('returns stub for unknown media key', () => {
    const scraper = getScraperForMedia('unknown_media_xyz');
    expect(scraper.listPageUrls).toHaveLength(0);
  });
});
