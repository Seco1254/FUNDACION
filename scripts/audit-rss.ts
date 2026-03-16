/**
 * RSS Audit Script — runs RSS discovery, measures metrics, checks dedupe,
 * and reports editorial quality of discovered articles.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';
import { EventBus } from '../src/core/event_bus/dispatcher.js';
import { ArticleRepository } from '../src/modules/articles/repo/article-repo.js';
import { RssDiscoveryJob } from '../src/modules/ingestion/rss/rss-discovery-job.js';
import { AuditRepository } from '../src/modules/audit/repo/audit-repo.js';
import { AuditService } from '../src/modules/audit/service/audit-service.js';

async function main() {
  const mode = process.argv[2] || 'status';

  const articleRepo = new ArticleRepository(prisma);
  const eventBus = new EventBus();
  const auditRepo = new AuditRepository(prisma);
  const auditService = new AuditService(auditRepo);
  eventBus.setAuditLogWriter(auditService);

  if (mode === 'status') {
    // Just show current DB state
    const mediaCount = await prisma.media.count();
    const rssMedia = await prisma.media.findMany({
      where: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } },
      select: { id: true, mediaKey: true, name: true, allowlisted: true },
    });
    const articleCount = await prisma.article.count();
    const eventCount = await prisma.event.count();
    const rssArticles = await prisma.article.count({
      where: { media: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } } },
    });
    console.log(JSON.stringify({ mediaCount, rssMedia, articleCount, eventCount, rssArticles }, null, 2));
  }

  if (mode === 'run') {
    // Run RSS discovery
    const rssJob = new RssDiscoveryJob(articleRepo, eventBus);

    console.log('=== RSS Discovery Run 1 ===');
    const r1 = await rssJob.run();
    console.log(JSON.stringify(r1, null, 2));

    console.log('\n=== RSS Discovery Run 2 (dedupe test - same process) ===');
    const r2 = await rssJob.run();
    console.log(JSON.stringify(r2, null, 2));

    console.log('\n=== RSS Discovery Run 3 (fresh instance - DB dedupe test) ===');
    const rssJob2 = new RssDiscoveryJob(articleRepo, eventBus);
    const r3 = await rssJob2.run();
    console.log(JSON.stringify(r3, null, 2));
  }

  if (mode === 'articles') {
    // Show RSS-sourced articles
    const rssArticles = await prisma.article.findMany({
      where: { media: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } } },
      select: {
        id: true,
        title: true,
        url: true,
        publishedAt: true,
        embeddingHash: true,
        media: { select: { mediaKey: true, name: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: 50,
    });

    console.log(`Total RSS articles in DB: ${rssArticles.length}`);
    for (const a of rssArticles) {
      console.log(JSON.stringify({
        id: a.id,
        media: a.media?.mediaKey,
        title: a.title?.slice(0, 100),
        url: a.url,
        publishedAt: a.publishedAt?.toISOString(),
        hasEmbedding: !!a.embeddingHash,
      }));
    }
  }

  if (mode === 'impact') {
    // Check downstream impact
    const rssMediaIds = await prisma.media.findMany({
      where: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } },
      select: { id: true, mediaKey: true },
    });
    const mediaIdMap = new Map(rssMediaIds.map(m => [m.id, m.mediaKey]));
    const mediaIds = rssMediaIds.map(m => m.id);

    // RSS articles with embeddings
    const withEmbedding = await prisma.article.count({
      where: { mediaId: { in: mediaIds }, embeddingHash: { not: '' } },
    });

    // RSS articles linked to events
    const linked = await prisma.eventArticle.findMany({
      where: { article: { mediaId: { in: mediaIds } } },
      include: {
        article: { select: { title: true, mediaId: true, media: { select: { mediaKey: true } } } },
        event: { select: { id: true, status: true } },
      },
    });

    // Events that contain RSS articles
    const rssEventIds = new Set(linked.map(l => l.eventId));

    // Multi-source events involving RSS
    const multiSourceWithRss: string[] = [];
    for (const eventId of rssEventIds) {
      const eventArts = await prisma.eventArticle.findMany({
        where: { eventId },
        include: { article: { select: { mediaId: true, media: { select: { mediaKey: true } } } } },
      });
      const sources = new Set(eventArts.map(ea => ea.article.media?.mediaKey));
      if (sources.size >= 2) {
        multiSourceWithRss.push(eventId);
      }
    }

    // Published events with RSS articles
    const publishedWithRss = linked.filter(l => l.event.status === 'PUBLISHED').length;

    // Total DB stats
    const totalArticles = await prisma.article.count();
    const totalEvents = await prisma.event.count();
    const totalPublished = await prisma.event.count({ where: { status: 'PUBLISHED' } });
    const totalRssArticles = await prisma.article.count({ where: { mediaId: { in: mediaIds } } });

    console.log(JSON.stringify({
      totalArticles,
      totalEvents,
      totalPublished,
      rssArticles: totalRssArticles,
      rssWithEmbedding: withEmbedding,
      rssLinkedToEvents: linked.length,
      rssEventsTotal: rssEventIds.size,
      rssMultiSourceEvents: multiSourceWithRss.length,
      rssPublishedLinks: publishedWithRss,
      linkedDetails: linked.map(l => ({
        eventId: l.eventId,
        eventStatus: l.event.status,
        articleTitle: l.article.title?.slice(0, 80),
        articleMedia: l.article.media?.mediaKey,
      })),
    }, null, 2));
  }

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
