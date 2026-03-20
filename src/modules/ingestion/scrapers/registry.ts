import { MediaScraper } from '../domain/types.js';
import { ElTiempoScraper } from './eltiempo.js';
import { ElEspectadorScraper } from './elespectador.js';
import { RazonPublicaScraper } from './razon-publica.js';
import { FlipScraper } from './flip.js';
import { ConsonanteScraper } from './consonante.js';
import { OecScraper } from './oec.js';
import { AscolbiScraper } from './ascolbi.js';
import { AciurScraper } from './aciur.js';
import { LaRepublicaScraper } from './larepublica.js';
import { StubScraper } from './stub-scraper.js';

const scrapers: Map<string, MediaScraper> = new Map();
scrapers.set('eltiempo', new ElTiempoScraper());
scrapers.set('elespectador', new ElEspectadorScraper());
scrapers.set('razon_publica', new RazonPublicaScraper());
scrapers.set('flip', new FlipScraper());
scrapers.set('consonante', new ConsonanteScraper());
scrapers.set('oec', new OecScraper());
scrapers.set('ascolbi', new AscolbiScraper());
scrapers.set('aciur', new AciurScraper());
scrapers.set('larepublica', new LaRepublicaScraper());

// RSS-only sources: no HTML scraper needed — discovery happens via RSS feeds.
// StubScraper ensures getScraperForMedia returns a valid scraper for these keys
// (listPageUrls=[] means ScrapeOrchestrator skips them).
const stubScraper = new StubScraper();
scrapers.set('servindi', stubScraper);
scrapers.set('prensa_rural', stubScraper);
scrapers.set('el_turbion', stubScraper);
scrapers.set('la_cola_de_rata', stubScraper);

export function getScraperForMedia(mediaKey: string): MediaScraper {
  return scrapers.get(mediaKey) ?? stubScraper;
}
