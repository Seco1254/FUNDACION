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
import { CambioScraper } from './cambio.js';
import { AmericasQuarterlyScraper } from './americas-quarterly.js';
import { PbsNewshourScraper } from './pbs-newshour.js';
import { CarnegieScraper } from './carnegie.js';
import { CrisisGroupScraper } from './crisis-group.js';
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
scrapers.set('cambio', new CambioScraper());
scrapers.set('americas_quarterly', new AmericasQuarterlyScraper());
scrapers.set('pbs_newshour', new PbsNewshourScraper());
scrapers.set('carnegie', new CarnegieScraper());
scrapers.set('crisis_group', new CrisisGroupScraper());

const stubScraper = new StubScraper();

export function getScraperForMedia(mediaKey: string): MediaScraper {
  return scrapers.get(mediaKey) ?? stubScraper;
}
