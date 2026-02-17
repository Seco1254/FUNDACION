import { MediaScraper } from '../domain/types.js';
import { ElTiempoScraper } from './eltiempo.js';
import { ElEspectadorScraper } from './elespectador.js';
import { StubScraper } from './stub-scraper.js';

const scrapers: Map<string, MediaScraper> = new Map();
scrapers.set('eltiempo', new ElTiempoScraper());
scrapers.set('elespectador', new ElEspectadorScraper());

const stubScraper = new StubScraper();

export function getScraperForMedia(mediaKey: string): MediaScraper {
  return scrapers.get(mediaKey) ?? stubScraper;
}
