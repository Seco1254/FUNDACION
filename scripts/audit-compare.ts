/**
 * Collect comprehensive pipeline metrics for branch comparison.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';

async function main() {
  const mode = process.argv[2] || 'metrics';

  if (mode === 'clean-rss') {
    // Delete RSS articles and their events
    const rssMediaIds = await prisma.media.findMany({
      where: { mediaKey: { in: ['servindi', 'prensa_rural', 'el_turbion', 'la_cola_de_rata'] } },
      select: { id: true },
    });
    const mediaIds = rssMediaIds.map(m => m.id);

    const rssEventArticles = await prisma.eventArticle.findMany({
      where: { article: { mediaId: { in: mediaIds } } },
      select: { eventId: true },
    });
    const rssEventIds = [...new Set(rssEventArticles.map(ea => ea.eventId))];

    for (const eventId of rssEventIds) {
      const allArts = await prisma.eventArticle.findMany({
        where: { eventId },
        include: { article: { select: { mediaId: true } } },
      });
      const hasNonRss = allArts.some(ea => !mediaIds.includes(ea.article.mediaId));
      if (!hasNonRss) {
        await prisma.quote.deleteMany({ where: { claim: { eventId } } });
        await prisma.claim.deleteMany({ where: { eventId } });
        await prisma.eventArticle.deleteMany({ where: { eventId } });
        await prisma.eventVersion.deleteMany({ where: { eventId } });
        await prisma.event.deleteMany({ where: { id: eventId } });
      } else {
        await prisma.eventArticle.deleteMany({
          where: { eventId, article: { mediaId: { in: mediaIds } } },
        });
      }
    }
    const deleted = await prisma.article.deleteMany({ where: { mediaId: { in: mediaIds } } });
    console.log(`Cleaned ${deleted.count} RSS articles`);
  }

  if (mode === 'metrics') {
    // INGESTION
    const totalArticles = await prisma.article.count();
    const byStatus = await prisma.$queryRawUnsafe<any[]>(`
      SELECT status, COUNT(*) as cnt FROM article GROUP BY status ORDER BY cnt DESC
    `);

    // Text quality
    const textStats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        ROUND(AVG(text_content_len)::numeric, 0) as avg_len,
        ROUND(AVG(CASE WHEN text_content_len < 500 THEN 1 ELSE 0 END)::numeric * 100, 1) as pct_short,
        COUNT(CASE WHEN text_content_source = 'rss' THEN 1 END) as rss_source,
        COUNT(CASE WHEN text_content_source = 'body' THEN 1 END) as body_source,
        COUNT(CASE WHEN text_content_source = 'meta' THEN 1 END) as meta_source,
        COUNT(CASE WHEN text_content_source = 'none' THEN 1 END) as none_source,
        COUNT(CASE WHEN usable_for_overview = true THEN 1 END) as usable,
        COUNT(CASE WHEN extraction_fail_reason IS NOT NULL THEN 1 END) as has_fail
      FROM article
    `);

    // By media
    const byMedia = await prisma.$queryRawUnsafe<any[]>(`
      SELECT m.media_key, COUNT(*) as cnt,
        ROUND(AVG(a.text_content_len)::numeric, 0) as avg_len
      FROM article a JOIN media m ON a.media_id = m.id
      GROUP BY m.media_key ORDER BY cnt DESC
    `);

    // CLUSTERING
    const totalEvents = await prisma.event.count();
    const eventsByState = await prisma.$queryRawUnsafe<any[]>(`
      SELECT state, COUNT(*) as cnt FROM event GROUP BY state ORDER BY cnt DESC
    `);

    const artsPerEvent = await prisma.$queryRawUnsafe<any[]>(`
      SELECT ROUND(AVG(cnt)::numeric, 2) as avg_arts,
        MAX(cnt) as max_arts,
        COUNT(CASE WHEN cnt = 1 THEN 1 END) as singletons,
        COUNT(CASE WHEN cnt >= 2 THEN 1 END) as multi_art
      FROM (SELECT event_id, COUNT(*) as cnt FROM event_article GROUP BY event_id) sub
    `);

    const multiSource = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as cnt FROM (
        SELECT ea.event_id
        FROM event_article ea JOIN article a ON a.id = ea.article_id
        GROUP BY ea.event_id HAVING COUNT(DISTINCT a.media_id) >= 2
      ) sub
    `);

    // OVERVIEW
    const overviewStats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(*) as total_versions,
        COUNT(CASE WHEN packet_json::text LIKE '%what_happened%' THEN 1 END) as has_overview,
        COUNT(CASE WHEN packet_json::text NOT LIKE '%what_happened%' OR packet_json IS NULL THEN 1 END) as no_overview
      FROM event_version
    `);

    // FEED - events with versions
    const publishedEvents = await prisma.$queryRawUnsafe<any[]>(`
      SELECT COUNT(*) as cnt FROM event WHERE state = 'PUBLISHED'
    `);

    // Embedding stats
    const embeddingStats = await prisma.$queryRawUnsafe<any[]>(`
      SELECT
        COUNT(CASE WHEN embedding_hash != '' AND embedding_hash IS NOT NULL THEN 1 END) as has_embedding,
        COUNT(CASE WHEN embedding_hash = '' OR embedding_hash IS NULL THEN 1 END) as no_embedding
      FROM article
    `);

    // RSS-specific
    const rssArticles = await prisma.$queryRawUnsafe<any[]>(`
      SELECT m.media_key, COUNT(*) as cnt
      FROM article a JOIN media m ON a.media_id = m.id
      WHERE m.media_key IN ('servindi','prensa_rural','el_turbion','la_cola_de_rata')
      GROUP BY m.media_key
    `);

    const toNum = (obj: any) => JSON.parse(JSON.stringify(obj, (_, v) => typeof v === 'bigint' ? Number(v) : v));
    console.log(JSON.stringify(toNum({
      ingestion: { totalArticles, byStatus, byMedia },
      extraction: textStats[0],
      embedding: embeddingStats[0],
      clustering: { totalEvents, eventsByState, artsPerEvent: artsPerEvent[0], multiSource: multiSource[0]?.cnt },
      overview: overviewStats[0],
      feed: { published: publishedEvents[0]?.cnt },
      rss: rssArticles,
    }), null, 2));
  }

  if (mode === 'sample') {
    // Get 10 random events with articles and version info
    const events = await prisma.$queryRawUnsafe<any[]>(`
      SELECT e.id, e.state, ev.headline,
        LEFT(ev.packet_json::text, 500) as packet_preview,
        (SELECT COUNT(*) FROM event_article ea WHERE ea.event_id = e.id) as art_count,
        (SELECT COUNT(DISTINCT a.media_id) FROM event_article ea JOIN article a ON a.id = ea.article_id WHERE ea.event_id = e.id) as source_count
      FROM event e
      LEFT JOIN event_version ev ON ev.event_id = e.id
      ORDER BY e.created_at DESC
      LIMIT 15
    `);
    for (const e of events) {
      console.log(JSON.stringify({
        id: e.id?.slice(0, 12),
        state: e.state,
        headline: e.headline?.slice(0, 80),
        arts: Number(e.art_count),
        sources: Number(e.source_count),
        has_overview: e.packet_preview?.includes('what_happened'),
      }));
    }
  }

  await prisma.$disconnect();
}
main().catch(err => { console.error(err); process.exit(1); });
