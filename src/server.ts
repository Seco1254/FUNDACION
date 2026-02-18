import './env.js'; // Must be first — loads .env before Prisma/config reads process.env
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
import { EventLinkerV2 } from './modules/event_linker/service/event-linker-v2.js';
import { LifecycleManager } from './modules/lifecycle/service/lifecycle-manager.js';
import { VersioningHandler } from './modules/versioning/service/versioning-handler.js';
import { VersionRepository } from './modules/versions/repo/version-repo.js';
import { ClaimRepository } from './modules/claims/repo/claim-repo.js';
import { ClaimQuoteExtractor } from './modules/claims/service/claim-extractor.js';
import { OverviewGenerator } from './modules/overview/service/overview-generator.js';
import { BiasLabelRepository } from './modules/bias/repo/bias-label-repo.js';
import { MediaProfileRepository } from './modules/bias/repo/media-profile-repo.js';
import { BiasProfiler } from './modules/bias/service/bias-profiler.js';
import { TopicAssignmentRepository } from './modules/topics/repo/topic-assignment-repo.js';
import { TopicAssigner } from './modules/topics/service/topic-assigner.js';
import { SubEventBuilder } from './modules/subevents/service/subevent-builder.js';
import { biasRoutes } from './api/routes/bias.js';
import { metricsRoutes } from './api/routes/metrics.js';
import { LlmClient } from './core/llm/index.js';
import { debugAiRoutes } from './api/routes/debug-ai.js';
import { createPublishedHandler } from './modules/overview/service/ai-enrichment.js';

// Phase 5: Production infrastructure
import { Cache } from './core/cache/cache.js';
import { SingleFlight } from './core/cache/singleflight.js';
import { RateLimiter } from './core/http/rate-limiter.js';
import { registerCacheInvalidation } from './core/cache/invalidation.js';
import { registerMetricSubscribers } from './core/metrics/subscribers.js';

import { scrapeLock } from './modules/ingestion/service/scrape-lock.js';
import { withTimeout } from './core/async/with-timeout.js';
import { RankingService } from './modules/ranking/service/ranking-service.js';

export function buildApp() {
  const app = Fastify({
    logger: false,
    requestTimeout: parseInt(process.env.REQUEST_TIMEOUT_MS ?? '30000', 10),
  });

  // CORS
  app.register(cors);

  // Phase 5: Rate limiting
  const rateLimiter = new RateLimiter({
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10),
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '60', 10),
  });
  app.addHook('onRequest', rateLimiter.hook());

  // Trace middleware
  app.addHook('onRequest', traceMiddleware);
  app.addHook('onResponse', onResponseHook);

  // Phase 5: In-memory cache + singleflight
  const cache = new Cache({
    maxEntries: parseInt(process.env.CACHE_MAX_ENTRIES ?? '500', 10),
    defaultTtlMs: parseInt(process.env.CACHE_DEFAULT_TTL_MS ?? '30000', 10),
  });
  const singleFlight = new SingleFlight();

  // Repositories
  const eventRepo = new EventRepository(prisma);
  const feedRepo = new FeedRepository(eventRepo);
  const auditRepo = new AuditRepository(prisma);
  const articleRepo = new ArticleRepository(prisma);
  const mediaRepo = new MediaRepository(prisma);

  // Services (feedService initialized after claimRepo for ranking)
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
  const schedulerScrapeTimeoutMs = parseInt(process.env.SCRAPE_TIMEOUT_MS ?? '60000', 10);
  const scheduler = new Scheduler(clock, async (job) => {
    if (job.jobKey === 'scrape:tick') {
      const traceId = `sched-${Date.now()}`;
      if (!scrapeLock.tryAcquire(traceId)) {
        logger.info({ jobKey: job.jobKey }, 'scheduler_scrape_skipped_locked');
        return;
      }
      try {
        await withTimeout(scrapeOrchestrator.run(), schedulerScrapeTimeoutMs, { stage: 'scheduler_scrape' });
        scrapeLock.release({});
      } catch (err) {
        scrapeLock.release({ error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
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

  // Phase 3: Claims → Overview (with optional LLM)
  const llmClient = new LlmClient();
  const llm = llmClient.isAvailable() ? llmClient : null;
  if (llm) {
    logger.info('llm_client_available');
  } else {
    logger.info('llm_client_unavailable_heuristic_mode');
  }

  // EventLinker v2 (with optional LLM pair scoring)
  const eventLinker = new EventLinkerV2(articleRepo, eventRepo, eventBus, auditService, clock, llm);

  const claimRepo = new ClaimRepository(prisma);
  const claimExtractor = new ClaimQuoteExtractor(eventRepo, versionRepo, mediaRepo, claimRepo, eventBus, auditService, llm);
  const overviewGenerator = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditService, llm);

  // Ranking (needs claimRepo for Q formula)
  const rankingService = new RankingService(eventRepo, claimRepo);
  const feedService = new FeedService(feedRepo, rankingService);

  // Phase 4: Bias → Topics → SubEvents
  const biasRepo = new BiasLabelRepository(prisma);
  const mediaProfileRepo = new MediaProfileRepository(prisma);
  const topicRepo = new TopicAssignmentRepository(prisma);
  const biasProfiler = new BiasProfiler(eventRepo, claimRepo, biasRepo, mediaProfileRepo, mediaRepo, eventBus, auditService);
  const topicAssigner = new TopicAssigner(eventRepo, claimRepo, topicRepo, versionRepo, eventBus, auditService);
  const subEventBuilder = new SubEventBuilder(topicRepo, claimRepo, versionRepo, eventBus, auditService);

  eventBus.subscribe('ArticlePolicyOk', 'EmbeddingService', embeddingService.handler());
  eventBus.subscribe('ArticleEmbedded', 'EventLinkerV2', eventLinker.handler());
  eventBus.subscribe('EventCreated', 'LifecycleManager.handleEventCreated', lifecycleManager.handleEventCreated());
  eventBus.subscribe('ArticleLinkedToEvent', 'LifecycleManager.handleArticleLinked', lifecycleManager.handleArticleLinked());
  eventBus.subscribe('EventUpdateTriggered', 'VersioningHandler', versioningHandler.handler());
  eventBus.subscribe('EventVersionCommitted', 'ClaimQuoteExtractor', claimExtractor.handler());
  eventBus.subscribe('ClaimGraphBuilt', 'OverviewGenerator', overviewGenerator.handler());
  eventBus.subscribe('OverviewGenerated', 'TopicAssigner', topicAssigner.handler());
  eventBus.subscribe('OverviewGenerated', 'BiasProfiler', biasProfiler.handler());
  eventBus.subscribe('TopicHeatmapBuilt', 'SubEventBuilder', subEventBuilder.handler());

  // Phase 6: Auto-run AI enrichment on publish
  const aiPublishedHandler = createPublishedHandler(versionRepo, claimRepo, claimExtractor, overviewGenerator);
  eventBus.subscribe('EventPublished', 'AiPipeline.onPublished', aiPublishedHandler);

  // Phase 5: Cache invalidation via event bus
  registerCacheInvalidation(eventBus, cache);

  // Phase 5: Metrics instrumentation via event bus
  registerMetricSubscribers(eventBus);

  // Routes
  app.register(healthRoutes);
  app.register(tabsRoutes);
  app.register(feedRoutes(feedService, cache, singleFlight));
  app.register(eventDetailRoutes(eventRepo, claimRepo, biasRepo, cache, singleFlight));
  app.register(biasRoutes(eventRepo, biasRepo, cache));
  app.register(metricsRoutes);
  app.register(debugScrapeRoutes(scrapeOrchestrator));
  app.register(debugAiRoutes(eventRepo, claimRepo, versionRepo, mediaRepo, eventBus, auditService, llm));

  return { app, scheduler, lifecycleManager, eventRepo, scrapeOrchestrator };
}

const SCHEDULER_TICK_MS = 30_000;
const SCRAPE_INTERVAL_MS = 15 * 60 * 1000;

async function start() {
  const { app, scheduler, lifecycleManager, eventRepo, scrapeOrchestrator } = buildApp();
  const port = parseInt(process.env.PORT ?? '3000', 10);

  try {
    await app.listen({ port, host: '0.0.0.0' });
    logger.info({ port, url: `http://localhost:${port}` }, 'server_started');
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
    if (code === 'EADDRINUSE') {
      logger.error(
        { port },
        [
          `port_in_use: Port ${port} is already in use.`,
          `  Try one of:`,
          `    PORT=${port + 1} npm start`,
          `    lsof -ti:${port} | xargs kill -9`,
        ].join('\n'),
      );
    } else {
      logger.error(err, 'server_start_failed');
    }
    process.exit(1);
  }

  // Rehydrate: publish any PENDING_PUBLISH events whose publishAt has passed
  try {
    const pending = await eventRepo.findPendingPublish();
    const now = new Date();
    let rehydrated = 0;
    for (const evt of pending) {
      if (!evt.publishAt || evt.publishAt <= now) {
        await lifecycleManager.executePublish(evt.id);
        rehydrated++;
      } else {
        scheduler.register(`publish:${evt.id}`, evt.publishAt, { eventId: evt.id });
      }
    }
    if (pending.length > 0) {
      logger.info({ total: pending.length, published_now: rehydrated }, 'startup_rehydration_complete');
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'startup_rehydration_failed');
  }

  // Register periodic scrape job
  const nextScrape = new Date(Date.now() + SCRAPE_INTERVAL_MS);
  scheduler.register('scrape:tick', nextScrape, {});

  // Scheduler tick: check and execute due jobs every 30s, re-register recurring jobs
  setInterval(async () => {
    try {
      const executed = await scheduler.runDueJobs();
      if (executed > 0) {
        logger.info({ executed }, 'scheduler_tick');
        // Re-register recurring scrape
        const next = new Date(Date.now() + SCRAPE_INTERVAL_MS);
        scheduler.register('scrape:tick', next, {});
      }
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'scheduler_tick_failed');
    }
  }, SCHEDULER_TICK_MS);
}

start();
