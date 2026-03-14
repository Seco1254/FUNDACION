/**
 * Quick script to create event versions and publish all DETECTED events
 * so they appear in the feed for audit purposes.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';
import { randomUUID } from 'crypto';

async function main() {
  const events = await prisma.event.findMany({
    where: { state: 'DETECTED' },
    include: {
      eventArticles: {
        include: {
          article: {
            include: { media: true },
          },
        },
      },
    },
  });

  console.log(`Found ${events.length} DETECTED events to publish.`);

  let published = 0;
  for (const event of events) {
    const articles = event.eventArticles.map((ea: any) => ea.article);
    if (articles.length === 0) continue;

    // Use first article's title as headline
    const headline = articles[0].title;
    const sourceCount = new Set(articles.map((a: any) => a.mediaId)).size;
    const articleCount = articles.length;

    // Create event version
    const latestVersion = await prisma.eventVersion.findFirst({
      where: { eventId: event.id },
      orderBy: { versionIndex: 'desc' },
    });

    const versionIndex = (latestVersion?.versionIndex ?? 0) + 1;

    await prisma.eventVersion.create({
      data: {
        id: randomUUID(),
        eventId: event.id,
        versionIndex,
        headline,
        packetJson: JSON.stringify({
          headline,
          article_count: articleCount,
          source_count: sourceCount,
          articles: articles.map((a: any) => ({
            id: a.id,
            title: a.title,
            media: a.media?.name ?? 'Unknown',
          })),
        }),
        createdAt: new Date(),
      },
    });

    // Update event state to PUBLISHED
    const now = new Date();
    await prisma.event.update({
      where: { id: event.id },
      data: {
        state: 'PUBLISHED',
        publishedAt: now,
        tLast: now,
      },
    });

    published++;
  }

  console.log(`Published ${published} events.`);

  // Verify
  const feedEvents = await prisma.event.count({ where: { state: 'PUBLISHED' } });
  const versions = await prisma.eventVersion.count();
  console.log(`Total PUBLISHED events: ${feedEvents}`);
  console.log(`Total event versions: ${versions}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
