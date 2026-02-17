import Fastify from 'fastify';
import cors from '@fastify/cors';
import { logger } from './core/logging/logger.js';
import { traceMiddleware, onResponseHook } from './core/logging/trace-middleware.js';
import { prisma } from './db/client.js';
import { healthRoutes } from './api/routes/health.js';
import { tabsRoutes } from './api/routes/tabs.js';
import { feedRoutes } from './api/routes/feed.js';
import { eventDetailRoutes } from './api/routes/event-detail.js';
import { EventRepository } from './modules/events/repo/event-repo.js';
import { FeedRepository } from './modules/feed/repo/feed-repo.js';
import { FeedService } from './modules/feed/service/feed-service.js';
import { AuditRepository } from './modules/audit/repo/audit-repo.js';
import { AuditService } from './modules/audit/service/audit-service.js';
import { EventBus } from './core/event_bus/dispatcher.js';
import { RealClock } from './core/time/clock.js';
import { Scheduler } from './core/scheduler/scheduler.js';
import { ArticleRepository } from './modules/articles/repo/article-repo.js';
import { MediaRepository } from './modules/media/repo/media-repo.js';
import { ScrapeOrchestrator } from './modules/ingestion/service/scrape-orchestrator.js';
import { FetcherParser } from './modules/ingestion/service/fetcher-parser.js';
import { PolicyGuard } from './modules/ingestion/service/policy-guard.js';
import { productionFetchHtml } from './modules/ingestion/service/fetch-html.js';
import { getScraperForMedia } from './modules/ingestion/scrapers/registry.js';
import { debugScrapeRoutes } from './api/routes/debug-scrape.js';
import { EmbeddingService } from './modules/embedding/service/embedding-service.js';
import { EventLinker } from './modules/event_linker/service/event-linker.js';
import { LifecycleManager } from './modules/lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from './modules/versioning/service/versioning-handler.js';
import { VersionRepository } from './modules/versions/repo/version-repo.js';
import { ClaimRepository } from './modules/claims/repo/claim-repo.js';
import { ClaimQuoteExtractor } from './modules/claims/service/claim-extractor.js';
import { OverviewGenerator } from './modules/overview/service/overview-generator.js';

export function buildApp() {
  const app = Fastify({ logger: false });

  // CORS
  app.register(cors);

  // Trace middleware
  app.addHook('onRequest', traceMiddleware);
  app.addHook('onResponse', onResponseHook);

  // Repositories
  const eventRepo = new EventRepository(prisma);
  const feedRepo = new FeedRepository(eventRepo);
  const auditRepo = new AuditRepository(prisma);
  const articleRepo = new ArticleRepository(prisma);
  const mediaRepo = new MediaRepository(prisma);

  // Services
  const feedService = new FeedService(feedRepo);
  const auditService = new AuditService(auditRepo);

  // Event bus
  const eventBus = new EventBus();
  eventBus.setAuditLogWriter(auditService);

  // Ingestion pipeline
  const fetcherParser = new FetcherParser(
    articleRepo, mediaRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
  );
  const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditService);

  eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
  eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());

  const scrapeOrchestrator = new ScrapeOrchestrator(
    mediaRepo, articleRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
  );

  // Phase 2: Embedding → EventLinker → Lifecycle → Versioning
  const clock = new RealClock();
  const versionRepo = new VersionRepository(prisma);

  const embeddingService = new EmbeddingService(articleRepo, eventBus, auditService);
  const eventLinker = new EventLinker(articleRepo, eventRepo, eventBus, auditService, clock);
  const scheduler = new Scheduler(clock, async (job) => {
    if (job.jobKey === 'scrape:tick') {
      await scrapeOrchestrator.run();
    } else if (job.jobKey.startsWith('publish:')) {
      const eventId = job.payload.eventId as string;
      await lifecycleManager.executePublish(eventId);
    } else if (job.jobKey.startsWith('refresh:')) {
      const eventId = job.payload.eventId as string;
      await lifecycleManager.executeRefresh(eventId);
    } else if (job.jobKey === 'lifecycle:close') {
      await lifecycleManager.runCloseCheck();
    } else if (job.jobKey === 'lifecycle:scheduleRefreshes') {
      await lifecycleManager.scheduleRefreshes();
    } else {
      logger.info({ jobKey: job.jobKey }, 'scheduler_job_stub');
    }
  });
  const lifecycleManager = new LifecycleManager(eventRepo, eventBus, auditService, scheduler, clock);
  const versioningHandler = new VersioningHandler(eventRepo, versionRepo, mediaRepo, eventBus);

  // Phase 3: Claims → Overview
  const claimRepo = new ClaimRepository(prisma);
  const claimExtractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditService);
  const overviewGenerator = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditService);

  eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
  eventBus.subscribe('ArticleEmbedded', 'EventLinker', eventLinker.handler());
  eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
  eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
  eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());
  eventBus.subscribe('EventVersionCommitted', 'ClaimQuoteExtractor', claimExtractor.handler());
  eventBus.subscribe('ClaimGraphBuilt', 'OverviewGenerator', overviewGenerator.handler());

  // Routes
  app.register(healthRoutes);
  app.register(tabsRoutes);
  app.register(feedRoutes(feedService));
  app.register(eventDetailRoutes(eventRepo, claimRepo));
  app.register(debugScrapeRoutes(scrapeOrchestrator));

  return app;
}

async function start() {
  const app = buildApp();
  const port = parseInt(process.env.PORT ?? '3000', 10);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port }, 'server_started');
  } catch (err) {
    logger.error(err, 'server_start_failed');
    process.exit(1);
  }
}

start();
