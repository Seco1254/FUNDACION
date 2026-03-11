/**
 * link-once: Re-processes existing POLICY_OK articles through
 * embedding → event linker → lifecycle → versioning pipeline.
 *
 * Usage: npm run link:once
 *
 * Use after scrape:once if articles exist but events=0.
 */
import { PrismaClient } from '@prisma/client';
import { ulid } from 'ulid';
import { EventBus } from '../core/event_bus/dispatcher.js';
import { AuditRepository } from '../modules/audit/repo/audit-repo.js';
import { AuditService } from '../modules/audit/service/audit-service.js';
import { ArticleRepository } from '../modules/articles/repo/article-repo.js';
import { MediaRepository } from '../modules/media/repo/media-repo.js';
import { EventRepository } from '../modules/events/repo/event-repo.js';
import { VersionRepository } from '../modules/versions/repo/version-repo.js';
import { EmbeddingService } from '../modules/embedding/service/embedding-service.js';
import { EventLinkerV2 } from '../modules/event_linker/service/event-linker-v2.js';
import { LifecycleManager } from '../modules/lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from '../modules/versioning/service/versioning-handler.js';
import { RealClock } from '../core/time/clock.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { LlmClient } from '../core/llm/index.js';

async function main() {
  const prisma = new PrismaClient();

  try {
    const auditRepo = new AuditRepository(prisma);
    const auditService = new AuditService(auditRepo);
    const articleRepo = new ArticleRepository(prisma);
    const mediaRepo = new MediaRepository(prisma);
    const eventRepo = new EventRepository(prisma);
    const versionRepo = new VersionRepository(prisma);
    const clock = new RealClock();

    const eventBus = new EventBus();
    eventBus.setAuditLogWriter(auditService);

    const llmClient = new LlmClient();
    const llm = llmClient.isAvailable() ? llmClient : null;

    const scheduler = new Scheduler(clock, async () => {});

    // Wire pipeline: Embedding → Linker → Lifecycle → Versioning
    const embeddingService = new EmbeddingService(articleRepo, eventBus, auditService);
    const eventLinker = new EventLinkerV2(articleRepo, eventRepo, eventBus, auditService, clock, llm);
    const lifecycleManager = new LifecycleManager(eventRepo, eventBus, auditService, scheduler, clock);
    const versioningHandler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);

    eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
    eventBus.subscribe('ArticleEmbedded', 'EventLinkerV2', eventLinker.handler());
    eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
    eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
    eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());

    // Find POLICY_OK articles not yet linked to events
    const policyOkArticles = await prisma.article.findMany({
      where: {
        status: 'POLICY_OK',
        eventArticles: { none: {} },
      },
      orderBy: { createdAt: 'asc' },
    });

    console.log(`Found ${policyOkArticles.length} unlinked POLICY_OK articles`);

    if (policyOkArticles.length === 0) {
      // Also count total articles by status for diagnostics
      const byStatus = await prisma.article.groupBy({ by: ['status'], _count: true });
      console.log('\nArticle breakdown:');
      for (const s of byStatus) {
        console.log(`  ${s.status}: ${s._count}`);
      }
      const linked = await prisma.eventArticle.count();
      console.log(`  already linked: ${linked}`);
      console.log('\nNothing to process.');
      return;
    }

    let processed = 0;
    let errors = 0;

    for (const article of policyOkArticles) {
      try {
        // Replay ArticlePolicyOk → triggers embedding → linking → lifecycle
        await eventBus.publish({
          event_name: 'ArticlePolicyOk',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: {
            trace_id: ulid(),
            span_id: ulid(),
            source_module: 'link-once',
          },
          payload: { article_id: article.id },
        });
        processed++;
      } catch (err) {
        errors++;
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Error processing ${article.url}: ${msg}`);
      }
    }

    // Final stats
    const eventCount = await prisma.event.count();
    const eventsByState = await prisma.event.groupBy({ by: ['state'], _count: true });
    const linkedCount = await prisma.eventArticle.count();

    console.log(`\nLink complete:`);
    console.log(`  processed: ${processed}`);
    console.log(`  errors:    ${errors}`);
    console.log(`  events:    ${eventCount}`);
    for (const s of eventsByState) {
      console.log(`    ${s.state}: ${s._count}`);
    }
    console.log(`  linked articles: ${linkedCount}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Link failed:', e);
  process.exit(1);
});
