import { FastifyInstance, FastifyPluginCallback } from 'fastify';
import { PrismaClient } from '@prisma/client';

export function debugPipelineRoutes(
  prisma: PrismaClient,
): FastifyPluginCallback {
  return (app: FastifyInstance, _opts, done) => {
    app.get('/v1/debug/pipeline/why-empty', async (_request, reply) => {
      // Core counts
      const mediaTotal = await prisma.media.count();
      const mediaEligible = await prisma.media.count({ where: { allowlisted: true } });
      const articleTotal = await prisma.article.count();
      const articleByStatus = await prisma.article.groupBy({ by: ['status'], _count: true });
      const eventTotal = await prisma.event.count();
      const eventByState = await prisma.event.groupBy({ by: ['state'], _count: true });

      // Linked articles
      const linkedArticles = await prisma.eventArticle.count();

      // Last 10 articles (for diagnostics)
      const lastArticles = await prisma.article.findMany({
        take: 10,
        orderBy: { createdAt: 'desc' },
        include: { media: { select: { mediaKey: true, name: true } } },
      });

      // Build status map
      const statusMap: Record<string, number> = {};
      for (const s of articleByStatus) {
        statusMap[s.status] = s._count;
      }
      const stateMap: Record<string, number> = {};
      for (const s of eventByState) {
        stateMap[s.state] = s._count;
      }

      // Determine reason
      let reason: string;
      const hints: string[] = [];

      if (mediaEligible === 0) {
        reason = 'NO_ELIGIBLE_MEDIA';
        hints.push('Media table has no allowlisted rows. Scraping cannot discover articles.');
        hints.push('Fix: npm run db:seed:minimal');
      } else if (articleTotal === 0) {
        reason = 'NO_ARTICLES';
        hints.push('No articles in DB. Scraping may not have run or all URLs were filtered.');
        hints.push('Fix: npm run scrape:once');
      } else if ((statusMap['POLICY_OK'] ?? 0) === 0) {
        reason = 'ALL_ARTICLES_BLOCKED';
        hints.push(`${articleTotal} articles exist but none passed policy.`);
        if (statusMap['POLICY_BLOCKED']) {
          hints.push(`POLICY_BLOCKED: ${statusMap['POLICY_BLOCKED']} (check language, snippet length, allowlist)`);
        }
        if (statusMap['NORMALIZED']) {
          hints.push(`NORMALIZED (stuck): ${statusMap['NORMALIZED']} (PolicyGuard may not have run)`);
        }
      } else if (eventTotal === 0) {
        reason = 'NO_EVENTS_CREATED';
        const unlinked = (statusMap['POLICY_OK'] ?? 0) - linkedArticles;
        hints.push(`${statusMap['POLICY_OK']} POLICY_OK articles exist but no events.`);
        hints.push(`${unlinked} articles are unlinked (not assigned to any event).`);
        hints.push('The embedding+linker pipeline has not processed these articles.');
        hints.push('Fix: npm run link:once   (replays POLICY_OK articles through linker)');
        hints.push('Or:  npm run scrape:once  (now includes full pipeline)');
      } else if ((stateMap['PUBLISHED'] ?? 0) === 0) {
        reason = 'NO_PUBLISHED_EVENTS';
        const pending = stateMap['PENDING_PUBLISH'] ?? 0;
        const detected = stateMap['DETECTED'] ?? 0;
        hints.push(`${eventTotal} events exist but none are PUBLISHED.`);
        if (pending > 0) {
          // Check oldest pending publish_at
          const oldest = await prisma.event.findFirst({
            where: { state: 'PENDING_PUBLISH' },
            orderBy: { publishAt: 'asc' },
            select: { id: true, publishAt: true },
          });
          const now = new Date();
          if (oldest?.publishAt && oldest.publishAt > now) {
            hints.push(`${pending} PENDING_PUBLISH events. Oldest publish_at: ${oldest.publishAt.toISOString()} (not due yet, wait or force).`);
          } else {
            hints.push(`${pending} PENDING_PUBLISH events. Oldest is due for publish.`);
          }
          hints.push('Fix: POST /v1/debug/lifecycle/tick   (force-publish due events)');
        }
        if (detected > 0) {
          hints.push(`${detected} DETECTED events (not yet scheduled for publish).`);
        }
      } else {
        // Published events exist — feed should not be empty unless gate filtered
        const publishedCount = stateMap['PUBLISHED'] ?? 0;
        reason = 'PUBLISHED_EVENTS_EXIST';
        hints.push(`${publishedCount} PUBLISHED events exist. Feed should have items.`);
        hints.push('If feed is empty, check gate filtering: GET /v1/debug/feed/stats');
      }

      return reply.send({
        reason,
        hints,
        media: {
          total: mediaTotal,
          eligible: mediaEligible,
        },
        articles: {
          total: articleTotal,
          by_status: statusMap,
          linked: linkedArticles,
          unlinked: articleTotal > 0 ? Math.max(0, (statusMap['POLICY_OK'] ?? 0) - linkedArticles) : 0,
        },
        events: {
          total: eventTotal,
          by_state: stateMap,
        },
        last_articles: lastArticles.map((a) => ({
          id: a.id,
          url: a.url,
          media_key: a.media?.mediaKey ?? 'unknown',
          status: a.status,
          created_at: a.createdAt.toISOString(),
        })),
      });
    });

    done();
  };
}
