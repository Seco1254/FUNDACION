import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const mediaEntries = Array.from({ length: 10 }, (_, i) => ({
    mediaKey: `MEDIA_${i + 1}`,
    name: `Media ${i + 1}`,
    allowlisted: true,
  }));

  for (const entry of mediaEntries) {
    await prisma.media.upsert({
      where: { mediaKey: entry.mediaKey },
      update: {},
      create: entry,
    });
  }

  console.log('Seed complete: 10 media entries created');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
