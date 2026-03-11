import '../src/env.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const blocked = await prisma.article.findMany({
    where: { status: 'POLICY_BLOCKED' },
    select: { url: true, title: true, contentType: true },
  });
  console.log('=== POLICY_BLOCKED articles ===');
  for (const a of blocked) {
    console.log(JSON.stringify({ url: a.url, title: (a.title || '').slice(0, 80), contentType: a.contentType }));
  }

  const audits = await prisma.auditLog.findMany({
    where: { action: 'PAGE_TYPE_BLOCKED' },
    select: { entityId: true, data: true },
  });
  console.log('\n=== PAGE_TYPE_BLOCKED audit entries ===');
  for (const a of audits) {
    console.log(JSON.stringify({ url: a.entityId, data: a.data }));
  }

  const masContenido = await prisma.article.findMany({
    where: { url: { contains: 'mas-contenido' } },
    select: { url: true, title: true, status: true, contentType: true, textContentLen: true },
  });
  console.log('\n=== /mas-contenido/ articles in DB ===');
  for (const a of masContenido) {
    console.log(JSON.stringify({ url: a.url, title: (a.title || '').slice(0, 80), status: a.status, contentType: a.contentType, textLen: a.textContentLen }));
  }

  const problemUrls = await prisma.article.findMany({
    where: {
      OR: [
        { url: { contains: '/autor/' } },
        { url: { contains: '/contenido-comercial/' } },
      ],
    },
    select: { url: true, title: true, status: true },
  });
  console.log('\n=== /autor/ or /contenido-comercial/ articles in DB ===');
  for (const a of problemUrls) {
    console.log(JSON.stringify({ url: a.url, title: (a.title || '').slice(0, 80), status: a.status }));
  }

  await prisma.$disconnect();
}

main();
