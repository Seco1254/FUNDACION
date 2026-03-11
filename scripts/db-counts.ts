import '../src/env.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  const articles = await p.article.count();
  const policyOk = await p.article.count({ where: { status: 'POLICY_OK' } });
  const policyBlocked = await p.article.count({ where: { status: 'POLICY_BLOCKED' } });
  const published = await p.event.count({ where: { state: 'PUBLISHED' } });
  const pendingPublish = await p.event.count({ where: { state: 'PENDING_PUBLISH' } });
  const detected = await p.event.count({ where: { state: 'DETECTED' } });
  const pageTypeBlocks = await p.auditLog.count({ where: { action: 'PAGE_TYPE_BLOCKED' } });

  console.log(JSON.stringify({
    articles, policyOk, policyBlocked,
    events: { published, pendingPublish, detected },
    pageTypeBlocks,
  }, null, 2));

  await p.$disconnect();
}

main().catch(console.error);
