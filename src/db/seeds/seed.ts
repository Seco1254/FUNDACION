import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface MediaSeed {
  mediaKey: string;
  name: string;
  allowlisted: boolean;
  license?: {
    license: string;
    attribution_required: boolean;
    non_commercial: boolean;
  };
}

const mediaEntries: MediaSeed[] = [
  { mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true },
  { mediaKey: 'elespectador', name: 'El Espectador', allowlisted: true },
  {
    mediaKey: 'razon_publica',
    name: 'Razón Pública',
    allowlisted: true,
    license: { license: 'CC-BY-NC-SA 3.0', attribution_required: true, non_commercial: true },
  },
  {
    mediaKey: 'flip',
    name: 'FLIP',
    allowlisted: true,
    license: { license: 'CC-BY-NC 4.0', attribution_required: true, non_commercial: true },
  },
  {
    mediaKey: 'consonante',
    name: 'Consonante',
    allowlisted: true,
    license: { license: 'CC-BY-NC-SA 4.0', attribution_required: true, non_commercial: true },
  },
  {
    mediaKey: 'oec',
    name: 'Observatorio Editorial Colombiano',
    allowlisted: true,
    license: { license: 'CC-BY-NC 4.0', attribution_required: true, non_commercial: true },
  },
  {
    mediaKey: 'ascolbi',
    name: 'Ascolbi',
    allowlisted: true,
    license: { license: 'CC-BY-NC 4.0', attribution_required: true, non_commercial: true },
  },
  {
    mediaKey: 'aciur',
    name: 'ACIUR',
    allowlisted: true,
    license: { license: 'CC-BY-NC-SA 4.0', attribution_required: true, non_commercial: true },
  },
  // RSS-discovered sources
  { mediaKey: 'servindi', name: 'Servindi', allowlisted: true },
  { mediaKey: 'prensa_rural', name: 'Agencia Prensa Rural', allowlisted: true },
  { mediaKey: 'el_turbion', name: 'El Turbión', allowlisted: true },
  { mediaKey: 'la_cola_de_rata', name: 'La Cola de Rata', allowlisted: true },
];

async function main() {
  for (const entry of mediaEntries) {
    const media = await prisma.media.upsert({
      where: { mediaKey: entry.mediaKey },
      update: {},
      create: { mediaKey: entry.mediaKey, name: entry.name, allowlisted: entry.allowlisted },
    });

    // Seed license metadata into MediaProfile if specified
    if (entry.license) {
      const existing = await prisma.mediaProfile.findUnique({ where: { mediaId: media.id } });
      const profile = (existing?.profileJson as Record<string, unknown>) ?? {};
      await prisma.mediaProfile.upsert({
        where: { mediaId: media.id },
        create: { mediaId: media.id, profileJson: { ...profile, ...entry.license } },
        update: { profileJson: { ...profile, ...entry.license } },
      });
    }
  }

  console.warn(`Seed complete: ${mediaEntries.length} media entries (2 legacy + 6 CC-licensed)`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
