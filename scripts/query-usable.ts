import '../src/env.js';
import { PrismaClient } from '@prisma/client';

async function main() {
  const p = new PrismaClient();

  const stats = await p.article.groupBy({
    by: ['usableForOverview'],
    _count: true,
  });
  console.log('Article usableForOverview distribution:', stats);

  // Check what a sample event looks like from the feed repo perspective
  const events = await p.event.findMany({
    where: { state: 'PUBLISHED' },
    select: {
      id: true,
      versions: {
        select: { headline: true },
        orderBy: { versionIndex: 'desc' as const },
        take: 1,
      },
      eventArticles: {
        select: {
          article: {
            select: {
              id: true,
              usableForOverview: true,
              textContentLen: true,
              status: true,
              contentType: true,
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  for (const e of events) {
    const articles = e.eventArticles.map((ea: any) => ea.article);
    const usable = articles.filter((a: any) => a.usableForOverview);
    const totalText = articles.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0);
    const usableText = usable.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0);
    console.log(JSON.stringify({
      id: e.id.slice(0, 12),
      headline: e.versions[0]?.headline?.slice(0, 60),
      articles: articles.length,
      usable_count: usable.length,
      total_text: totalText,
      usable_text: usableText,
      content_types: articles.map((a: any) => a.contentType),
    }));
  }

  await p.$disconnect();
}

main().catch(console.error);
