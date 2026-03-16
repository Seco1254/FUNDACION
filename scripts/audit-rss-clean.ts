/**
 * Clean RSS articles from DB for re-audit, then show state.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';

async function main() {
  const mode = process.argv[2] || 'status';

  if (mode === 'clean') {
    const rssMediaIds = await prisma.media.findMany({
      where: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } },
      select: { id: true, mediaKey: true },
    });
    const mediaIds = rssMediaIds.map(m => m.id);

    // Delete events that ONLY have RSS articles
    const rssEventArticles = await prisma.eventArticle.findMany({
      where: { article: { mediaId: { in: mediaIds } } },
      select: { eventId: true },
    });
    const rssEventIds = [...new Set(rssEventArticles.map(ea => ea.eventId))];

    // For each RSS event, check if it has non-RSS articles
    for (const eventId of rssEventIds) {
      const allArts = await prisma.eventArticle.findMany({
        where: { eventId },
        include: { article: { select: { mediaId: true } } },
      });
      const hasNonRss = allArts.some(ea => !mediaIds.includes(ea.article.mediaId));
      if (!hasNonRss) {
        // Pure RSS event — delete it and its relations
        await prisma.quote.deleteMany({ where: { claim: { eventId } } });
        await prisma.claim.deleteMany({ where: { eventId } });
        await prisma.eventArticle.deleteMany({ where: { eventId } });
        await prisma.eventVersion.deleteMany({ where: { eventId } });
        await prisma.event.deleteMany({ where: { id: eventId } });
      } else {
        // Mixed event — just unlink RSS articles
        await prisma.eventArticle.deleteMany({
          where: { eventId, article: { mediaId: { in: mediaIds } } },
        });
      }
    }

    // Delete RSS articles themselves
    const deleted = await prisma.article.deleteMany({
      where: { mediaId: { in: mediaIds } },
    });
    console.log(`Deleted ${deleted.count} RSS articles and their pure-RSS events`);
  }

  // Show current state
  const articleCount = await prisma.article.count();
  const eventCount = await prisma.event.count();
  const rssArticleCount = await prisma.article.count({
    where: { media: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } } },
  });
  console.log(JSON.stringify({ articleCount, eventCount, rssArticleCount }));

  await prisma.$disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
