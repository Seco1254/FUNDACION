import '../src/env.js';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Check why specific articles are POLICY_BLOCKED
  const blocked = await prisma.article.findMany({
    where: { status: 'POLICY_BLOCKED' },
    select: {
      url: true,
      title: true,
      contentType: true,
      contentTypeScore: true,
      routingDecision: true,
      textContentLen: true,
      textContentSource: true,
      extractionFailReason: true,
      usableForOverview: true,
      paywallDetected: true,
    },
  });

  console.log('=== POLICY_BLOCKED articles (full detail) ===');
  for (const a of blocked) {
    console.log(JSON.stringify({
      url: a.url,
      title: (a.title || '').slice(0, 80),
      contentType: a.contentType,
      contentTypeScore: a.contentTypeScore,
      routing: a.routingDecision,
      textLen: a.textContentLen,
      textSource: a.textContentSource,
      extractionFail: a.extractionFailReason,
      usable: a.usableForOverview,
      paywall: a.paywallDetected,
    }));
  }

  // Check audit logs for these specific URLs
  const blockedUrls = blocked.map(a => a.url);
  const articleIds = await prisma.article.findMany({
    where: { url: { in: blockedUrls } },
    select: { id: true, url: true },
  });

  const audits = await prisma.auditLog.findMany({
    where: {
      entityId: { in: articleIds.map(a => a.id) },
    },
    select: { entityId: true, action: true, data: true },
  });

  console.log('\n=== Audit logs for blocked articles ===');
  for (const a of audits) {
    const art = articleIds.find(ai => ai.id === a.entityId);
    console.log(JSON.stringify({ url: art?.url?.slice(0, 80), action: a.action, data: a.data }));
  }

  await prisma.$disconnect();
}

main();
