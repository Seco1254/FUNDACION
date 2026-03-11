import '../src/env.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  const events = await p.event.findMany({
    where: { state: 'PUBLISHED', canonicalEventId: null },
    select: {
      id: true,
      versions: {
        select: { headline: true, packetJson: true },
        orderBy: { versionIndex: 'desc' as const },
        take: 1,
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  for (const e of events) {
    const v = e.versions[0];
    const pkt = v?.packetJson as any;
    const cg = pkt?.coherence_gate;
    console.log(JSON.stringify({
      id: e.id.slice(0, 12),
      headline: v?.headline?.slice(0, 60),
      title_jaccard: cg?.metrics?.title_jaccard ?? null,
      coherence_status: cg?.status ?? null,
      has_coherence: !!cg,
    }));
  }

  await p.$disconnect();
}

main().catch(console.error);
