import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { MediaRepository } from '../../modules/media/repo/media-repo.js';

const KNOWN_SCRAPERS = new Set([
  'eltiempo', 'elespectador', 'razon_publica', 'flip',
  'consonante', 'oec', 'ascolbi', 'aciur',
]);

export function debugMediaRoutes(
  mediaRepo: MediaRepository,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/media/status', async (_request, reply) => {
      const allMedia = await mediaRepo.findAll();
      const eligible = allMedia.filter((m) => m.allowlisted);
      const excluded = allMedia.filter((m) => !m.allowlisted);

      const eligibleDetails = eligible.map((m) => ({
        media_key: m.mediaKey,
        name: m.name,
        has_scraper: KNOWN_SCRAPERS.has(m.mediaKey),
      }));

      const excludedDetails = excluded.map((m) => ({
        media_key: m.mediaKey,
        name: m.name,
        reason: 'allowlisted=false',
      }));

      // Check for scrapers with no DB row
      const dbKeys = new Set(allMedia.map((m) => m.mediaKey));
      const missingScraper: string[] = [];
      for (const key of KNOWN_SCRAPERS) {
        if (!dbKeys.has(key)) {
          missingScraper.push(key);
        }
      }

      return reply.send({
        media_total: allMedia.length,
        eligible_total: eligible.length,
        eligible_media_keys: eligible.map((m) => m.mediaKey),
        eligible: eligibleDetails,
        excluded: excludedDetails,
        missing_db_rows: missingScraper,
        fix: eligible.length === 0
          ? 'Run: npm run db:seed:minimal'
          : null,
      });
    });

    done();
  };
}
