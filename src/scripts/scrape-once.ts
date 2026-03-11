import { PrismaClient } from '@prisma/client';
import { EventBus } from '../core/event_bus/dispatcher.js';
import { AuditRepository } from '../modules/audit/repo/audit-repo.js';
import { AuditService } from '../modules/audit/service/audit-service.js';
import { ArticleRepository } from '../modules/articles/repo/article-repo.js';
import { MediaRepository } from '../modules/media/repo/media-repo.js';
import { EventRepository } from '../modules/events/repo/event-repo.js';
import { VersionRepository } from '../modules/versions/repo/version-repo.js';
import { ScrapeOrchestrator } from '../modules/ingestion/service/scrape-orchestrator.js';
import { FetcherParser } from '../modules/ingestion/service/fetcher-parser.js';
import { PolicyGuard } from '../modules/ingestion/service/policy-guard.js';
import { EmbeddingService } from '../modules/embedding/service/embedding-service.js';
import { EventLinkerV2 } from '../modules/event_linker/service/event-linker-v2.js';
import { LifecycleManager } from '../modules/lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from '../modules/versioning/service/versioning-handler.js';
import { RealClock } from '../core/time/clock.js';
import { Scheduler } from '../core/scheduler/scheduler.js';
import { LlmClient } from '../core/llm/index.js';
import { productionFetchHtml } from '../modules/ingestion/service/fetch-html.js';
import { getScraperForMedia } from '../modules/ingestion/scrapers/registry.js';

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

    // LLM (optional)
    const llmClient = new LlmClient();
    const llm = llmClient.isAvailable() ? llmClient : null;

    // Scheduler (no-op executor for scrape-once; publish jobs are executed inline)
    const scheduler = new Scheduler(clock, async () => {});

    // ── Full pipeline wiring ──────────────────────────────────────
    // Phase 1: Discovery → Fetch/Parse → Policy
    const fetcherParser = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
    );
    const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditService);

    // Phase 2: Embedding → Linking → Lifecycle → Versioning
    const embeddingService = new EmbeddingService(articleRepo, eventBus, auditService);
    const eventLinker = new EventLinkerV2(articleRepo, eventRepo, eventBus, auditService, clock, llm);
    const lifecycleManager = new LifecycleManager(eventRepo, eventBus, auditService, scheduler, clock);
    const versioningHandler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);

    eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
    eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());
    eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
    eventBus.subscribe('ArticleEmbedded', 'EventLinkerV2', eventLinker.handler());
    eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
    eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
    eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
    );

    console.log('Starting scrape run (full pipeline)...');
    const result = await orchestrator.run();

    if (result.media_results.length === 0) {
      console.error(
        '\n  FATAL: No eligible media found. Scraping cannot proceed.\n' +
        '  Fix: npm run db:seed:minimal\n',
      );
      process.exit(1);
    }

    // Print detailed summary
    console.log(`\nScrape complete:`);
    console.log(`  discovered: ${result.discovered}`);
    console.log(`  skipped:    ${result.skipped} (already_in_db: ${result.skip_reasons.already_in_db}, duplicate_in_run: ${result.skip_reasons.duplicate_in_run})`);

    if (result.discovered_urls.length > 0) {
      console.log(`  discovered URLs:`);
      for (const url of result.discovered_urls) {
        console.log(`    - ${url}`);
      }
    }

    // Post-scrape stats
    const articleCount = await prisma.article.count();
    const byStatus = await prisma.article.groupBy({ by: ['status'], _count: true });
    const eventCount = await prisma.event.count();
    const eventsByState = await prisma.event.groupBy({ by: ['state'], _count: true });

    console.log(`\nDB state after scrape:`);
    console.log(`  articles: ${articleCount}`);
    for (const s of byStatus) {
      console.log(`    ${s.status}: ${s._count}`);
    }
    console.log(`  events:   ${eventCount}`);
    for (const s of eventsByState) {
      console.log(`    ${s.state}: ${s._count}`);
    }

    if (eventCount === 0 && articleCount > 0) {
      console.log(`\n  Note: Articles exist but no events. The embedding+linker pipeline`);
      console.log(`  runs inline during scrape. If events=0, check for:`);
      console.log(`    - Policy blocked all articles (POLICY_BLOCKED count above)`);
      console.log(`    - Embedding failures (check logs above for article_missing_embedding)`);
      console.log(`    - Linker thresholds too strict (check THETA_AUTO_LINK in .env)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Scrape failed:', e);
  process.exit(1);
});
