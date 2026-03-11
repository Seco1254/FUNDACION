/**
 * Minimal seed: ensures allowlisted Media rows exist.
 * Does NOT touch downstream tables (MediaProfile, BiasLabel, etc.).
 *
 * Usage: npm run db:seed:minimal
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MEDIA_ALLOWLIST = [
  { mediaKey: 'eltiempo', name: 'El Tiempo' },
  { mediaKey: 'elespectador', name: 'El Espectador' },
  { mediaKey: 'razon_publica', name: 'Razón Pública' },
  { mediaKey: 'flip', name: 'FLIP' },
  { mediaKey: 'consonante', name: 'Consonante' },
  { mediaKey: 'oec', name: 'Observatorio Editorial Colombiano' },
  { mediaKey: 'ascolbi', name: 'Ascolbi' },
  { mediaKey: 'aciur', name: 'ACIUR' },
  // Premium sources (Wave 1)
  { mediaKey: 'larepublica', name: 'La República' },
  { mediaKey: 'cambio', name: 'CAMBIO' },
  { mediaKey: 'americas_quarterly', name: 'Americas Quarterly' },
  { mediaKey: 'pbs_newshour', name: 'PBS NewsHour' },
  { mediaKey: 'carnegie', name: 'Carnegie Endowment for International Peace' },
  { mediaKey: 'crisis_group', name: 'International Crisis Group' },
];

async function main() {
  let created = 0;
  let existed = 0;

  for (const entry of MEDIA_ALLOWLIST) {
    const result = await prisma.media.upsert({
      where: { mediaKey: entry.mediaKey },
      update: {},
      create: { mediaKey: entry.mediaKey, name: entry.name, allowlisted: true },
    });

    const wasNew = result.createdAt.getTime() > Date.now() - 2000;
    if (wasNew) created++;
    else existed++;
  }

  console.log(`seed:minimal complete — ${created} created, ${existed} already existed (${MEDIA_ALLOWLIST.length} total)`);

  // Verify
  const eligible = await prisma.media.count({ where: { allowlisted: true } });
  console.log(`Eligible media in DB: ${eligible}`);
  if (eligible === 0) {
    console.error('ERROR: No eligible media after seed. Check database connection.');
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error('seed:minimal failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
