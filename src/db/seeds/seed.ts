import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const mediaEntries = [
    { mediaKey: 'eltiempo', name: 'El Tiempo', allowlisted: true },
    { mediaKey: 'elespectador', name: 'El Espectador', allowlisted: true },
    ...Array.from({ length: 8 }, (_, i) => ({
      mediaKey: `MEDIA_${i + 3}`,
      name: `Media ${i + 3}`,
      allowlisted: true,
    })),
  ];

  for (const entry of mediaEntries) {
    await prisma.media.upsert({
      where: { mediaKey: entry.mediaKey },
      update: {},
      create: entry,
    });
  }

  console.log('Seed complete: 10 media entries created (2 real + 8 stubs)');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
