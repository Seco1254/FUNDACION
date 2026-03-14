/**
 * Relink audit script — deletes all events/links and re-runs the linker
 * with current thresholds to measure the effect of recent fixes.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';
import { EventBus } from '../src/core/event_bus/dispatcher.js';
import { ArticleRepository } from '../src/modules/articles/repo/article-repo.js';
import { EventRepository } from '../src/modules/events/repo/event-repo.js';
import { RealClock } from '../src/core/time/clock.js';
import { EventLinkerV2 } from '../src/modules/event_linker/service/event-linker-v2.js';
import { EmbeddingService } from '../src/modules/embedding/service/embedding-service.js';
import { ulid } from 'ulid';

async function main() {
  const articleRepo = new ArticleRepository(prisma);
  const eventRepo = new EventRepository(prisma);
  const eventBus = new EventBus();
  const clock = new RealClock();

  const auditWriter = {
    async write(_entry: any) { /* no-op for audit */ },
  };

  eventBus.setAuditLogWriter(auditWriter);

  // 1. Delete all existing events and links
  console.log('--- Cleaning existing events and links ---');
  await prisma.quote.deleteMany({});
  await prisma.claim.deleteMany({});
  await prisma.eventArticle.deleteMany({});
  await prisma.eventVersion.deleteMany({});
  await prisma.event.deleteMany({});
  console.log('Done cleaning.');

  // 2. Get all articles with embeddings, sorted by publishedAt
  const articles = await prisma.article.findMany({
    where: { embeddingHash: { not: '' } },
    orderBy: { publishedAt: 'asc' },
    select: { id: true, title: true, publishedAt: true },
  });
  console.log(`Found ${articles.length} articles with embeddings.`);

  // 3. Set up linker
  const linker = new EventLinkerV2(articleRepo, eventRepo, eventBus, auditWriter, clock);
  const handler = linker.handler();

  // 4. Process each article through the linker
  let processed = 0;
  for (const article of articles) {
    const envelope = {
      event_name: 'ArticleEmbedded',
      event_id: ulid(),
      occurred_at: new Date().toISOString(),
      trace: { trace_id: ulid(), span_id: ulid(), source_module: 'relink-audit' },
      payload: { article_id: article.id },
    };

    try {
      await handler(envelope);
      processed++;
      if (processed % 20 === 0) {
        console.log(`Processed ${processed}/${articles.length}`);
      }
    } catch (err) {
      console.error(`Error processing ${article.id}: ${err}`);
    }
  }

  console.log(`\nDone. Processed ${processed}/${articles.length} articles.`);

  // 5. Print summary metrics
  const totalEvents = await prisma.event.count();
  const totalLinks = await prisma.eventArticle.count();
  const eventsWithArticles = await prisma.$queryRawUnsafe<any[]>(`
    SELECT
      CASE
        WHEN cnt = 0 THEN '0_articles'
        WHEN cnt = 1 THEN '1_article'
        ELSE '2plus_articles'
      END as bucket,
      COUNT(*) as num
    FROM (
      SELECT e.id, COUNT(ea.article_id) as cnt
      FROM event e
      LEFT JOIN event_article ea ON ea.event_id = e.id
      GROUP BY e.id
    ) sub
    GROUP BY bucket
    ORDER BY bucket
  `);

  console.log('\n--- Summary ---');
  console.log(`Total events: ${totalEvents}`);
  console.log(`Total links: ${totalLinks}`);
  for (const row of eventsWithArticles) {
    console.log(`  ${row.bucket}: ${row.num}`);
  }

  const multiSourceEvents = await prisma.$queryRawUnsafe<any[]>(`
    SELECT COUNT(*) as cnt FROM (
      SELECT ea.event_id
      FROM event_article ea
      JOIN article a ON a.id = ea.article_id
      GROUP BY ea.event_id
      HAVING COUNT(DISTINCT a.media_id) >= 2
    ) sub
  `);
  console.log(`Events with 2+ sources: ${multiSourceEvents[0]?.cnt}`);

  const avgArts = await prisma.$queryRawUnsafe<any[]>(`
    SELECT ROUND(AVG(cnt)::numeric, 2) as avg_arts
    FROM (SELECT COUNT(*) as cnt FROM event_article GROUP BY event_id) sub
  `);
  console.log(`Avg articles per event: ${avgArts[0]?.avg_arts}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
