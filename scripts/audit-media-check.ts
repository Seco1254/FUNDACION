/**
 * Audit helper: check media sources and sample titles
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';

async function main() {
  // Media source counts
  const mediaCounts = await prisma.$queryRawUnsafe<any[]>(`
    SELECT m.name, COUNT(a.id)::int as cnt
    FROM article a
    JOIN media m ON a.media_id = m.id
    WHERE a.embedding_hash != ''
    GROUP BY m.name
    ORDER BY cnt DESC
  `);
  console.log('=== Media sources with embedded articles ===');
  for (const m of mediaCounts) console.log(`  ${m.name}: ${m.cnt}`);

  // Sample titles per media
  const medias = await prisma.$queryRawUnsafe<any[]>(
    `SELECT DISTINCT m.name, m.id FROM media m JOIN article a ON a.media_id = m.id WHERE a.embedding_hash != '' ORDER BY m.name`
  );
  for (const m of medias) {
    const arts = await prisma.$queryRawUnsafe<any[]>(
      `SELECT title FROM article WHERE media_id = '${m.id}' AND embedding_hash != '' ORDER BY published_at DESC LIMIT 8`
    );
    console.log(`\n=== ${m.name} (sample) ===`);
    for (const a of arts) console.log(`  - ${a.title.slice(0, 90)}`);
  }

  // Current event stats
  const totalArticles = await prisma.article.count({ where: { embeddingHash: { not: '' } } });
  const totalEvents = await prisma.event.count();
  const totalLinks = await prisma.eventArticle.count();

  // Multi-article events with their titles
  const multiArtEvents = await prisma.$queryRawUnsafe<any[]>(`
    SELECT e.id, COUNT(ea.article_id)::int as art_cnt,
           COUNT(DISTINCT a.media_id)::int as src_cnt
    FROM event e
    JOIN event_article ea ON ea.event_id = e.id
    JOIN article a ON a.id = ea.article_id
    GROUP BY e.id
    HAVING COUNT(ea.article_id) >= 2
    ORDER BY COUNT(ea.article_id) DESC
  `);

  console.log(`\n=== Multi-article events (${multiArtEvents.length} total) ===`);
  for (const ev of multiArtEvents) {
    const arts = await prisma.$queryRawUnsafe<any[]>(
      `SELECT a.title, m.name as media FROM event_article ea JOIN article a ON a.id = ea.article_id JOIN media m ON a.media_id = m.id WHERE ea.event_id = '${ev.id}' ORDER BY a.published_at`
    );
    console.log(`\n[Event ${ev.id.slice(0,8)}] ${ev.art_cnt} arts, ${ev.src_cnt} sources`);
    for (const a of arts) console.log(`  [${a.media}] ${a.title.slice(0, 90)}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Total articles (with embeddings): ${totalArticles}`);
  console.log(`Total events: ${totalEvents}`);
  console.log(`Total links: ${totalLinks}`);
  console.log(`Multi-article events: ${multiArtEvents.length}`);
  console.log(`Multi-source events: ${multiArtEvents.filter(e => e.src_cnt >= 2).length}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
