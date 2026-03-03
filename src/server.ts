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
import { addMs } from './core/time/runtime-time.js';
import { Scheduler } from './core/scheduler/scheduler.js';
import { ArticleRepository } from './modules/articles/repo/article-repo.js';
import { MediaRepository } from './modules/media/repo/media-repo.js';
import { ScrapeOrchestrator } from './modules/ingestion/service/scrape-orchestrator.js';
import { FetcherParser } from './modules/ingestion/service/fetcher-parser.js';
import { PolicyGuard } from './modules/ingestion/service/policy-guard.js';
import { productionFetchHtml } from './modules/ingestion/service/fetch-html.js';
import { getScraperForMedia } from './modules/ingestion/scrapers/registry.js';
import { debugScrapeRoutes } from './api/routes/debug-scrape.js';
import { debugSchedulerRoutes } from './api/routes/debug-scheduler.js';
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
import { rehydratePublishJobs } from './core/scheduler/rehydrate.js';
import { LlmClient } from './core/llm/index.js';
import { debugAiRoutes } from './api/routes/debug-ai.js';
import { debugFeedRoutes } from './api/routes/debug-feed.js';
import { debugQualityRoutes } from './api/routes/debug-quality.js';
import { debugLinkerRoutes } from './api/routes/debug-linker.js';
import { debugLifecycleRoutes } from './api/routes/debug-lifecycle.js';
import { debugMediaRoutes } from './api/routes/debug-media.js';
import { debugPipelineRoutes } from './api/routes/debug-pipeline.js';
import { debugCoherenceRoutes } from './api/routes/debug-coherence.js';
import { debugRoutingRoutes } from './api/routes/debug-routing.js';
import { debugExtractorRoutes } from './api/routes/debug-extractor.js';
import { debugLabelsRoutes } from './api/routes/debug-labels.js';
import { QualitySnapshotService } from './modules/quality/service/quality-snapshot.js';
import { createPublishedHandler } from './modules/overview/service/ai-enrichment.js';

// Phase 5: Production infrastructure
import { Cache } from './core/cache/cache.js';
import { SingleFlight } from './core/cache/singleflight.js';
import { RateLimiter } from './core/http/rate-limiter.js';
import { registerCacheInvalidation } from './core/cache/invalidation.js';
import { registerMetricSubscribers } from './core/metrics/subscribers.js';

import { runDevSeed } from './scripts/dev-seed.js';
import { scrapeLock } from './modules/ingestion/service/scrape-lock.js';
import { withTimeout } from './core/async/with-timeout.js';
import { RankingService } from './modules/ranking/service/ranking-service.js';

const SCHEDULER_TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS ?? '5000', 10);
const SCRAPE_INTERVAL_MS = parseInt(process.env.SCRAPE_INTERVAL_MS ?? String(15 * 60 * 1000), 10);
const CLOSE_CHECK_INTERVAL_MS = parseInt(process.env.CLOSE_CHECK_INTERVAL_MS ?? String(6 * 60 * 60 * 1000), 10);
const REFRESH_INTERVAL_MS = parseInt(process.env.REFRESH_INTERVAL_MS ?? String(30 * 60 * 1000), 10);

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
  const overviewGenerator = new OverviewGenerator(claimRepo, versionRepo, eventBus, auditService, llm, eventRepo);

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

  // Scheduler ticker — runs due jobs on a fixed interval with anti-overlap guard.
  // Interval is configurable via SCHEDULER_TICK_MS env var (default 5 s).
  // Re-registers the recurring scrape job after each execution so it never gets lost.
  let tickBusy = false;
  let tickCount = 0;
  const LOG_TICK_HEARTBEAT_EVERY = parseInt(process.env.LOG_TICK_HEARTBEAT_EVERY ?? '12', 10); // every ~60 s
  const tickHandle = setInterval(async () => {
    if (tickBusy) return; // anti-overlap: skip if previous tick is still running
    tickBusy = true;
    tickCount++;
    try {
      const executed = await scheduler.runDueJobs();
      if (executed > 0) {
        logger.info({ executed, pending: scheduler.list().length }, 'scheduler_tick');
        // Re-register the recurring scrape job if it was just consumed by this tick.
        if (!scheduler.list().some((j) => j.jobKey === 'scrape:tick')) {
          const next = new Date(Date.now() + SCRAPE_INTERVAL_MS);
          scheduler.register('scrape:tick', next, {});
          logger.info({ next_scrape: next.toISOString() }, 'scheduler_scrape_rescheduled');
        }
      } else if (tickCount % LOG_TICK_HEARTBEAT_EVERY === 0) {
        logger.info({ pending: scheduler.list().length, tick: tickCount }, 'scheduler_heartbeat');
      }
    } catch (e) {
      logger.error(e, 'scheduler_tick_failed');
    } finally {
      tickBusy = false;
    }
  }, SCHEDULER_TICK_MS);
  app.addHook('onClose', async () => { clearInterval(tickHandle); });

  // On startup: rehydrate PENDING_PUBLISH jobs from DB (lost on restart because
  // the scheduler is in-memory). Safe to call multiple times — dedup by jobKey.
  app.addHook('onReady', async () => {
    const n = await rehydratePublishJobs(scheduler, eventRepo);
    if (n > 0) logger.info({ rehydrated: n }, 'scheduler_rehydrated');
  });

  // Routes
  app.register(healthRoutes);
  app.register(tabsRoutes);
  app.register(feedRoutes(feedService, cache, singleFlight));
  app.register(eventDetailRoutes(eventRepo, claimRepo, biasRepo, cache, singleFlight));
  app.register(biasRoutes(eventRepo, biasRepo, cache));
  app.register(metricsRoutes);
  app.register(debugScrapeRoutes(scrapeOrchestrator));
  app.register(debugSchedulerRoutes(scheduler, SCHEDULER_TICK_MS));
  app.register(debugAiRoutes(eventRepo, claimRepo, versionRepo, mediaRepo, eventBus, auditService, llm));
  app.register(debugFeedRoutes(feedRepo, eventRepo, articleRepo));
  const qualityService = new QualitySnapshotService(prisma);
  app.register(debugQualityRoutes(qualityService));
  app.register(debugLinkerRoutes(auditRepo, eventRepo));
  app.register(debugLifecycleRoutes(lifecycleManager, eventRepo));
  app.register(debugMediaRoutes(mediaRepo));
  app.register(debugPipelineRoutes(prisma));
  app.register(debugCoherenceRoutes(prisma));
  app.register(debugRoutingRoutes(prisma));
  app.register(debugExtractorRoutes(prisma));
  app.register(debugLabelsRoutes(prisma));

  return { app, scheduler, lifecycleManager, eventRepo, scrapeOrchestrator, clock };
}

async function start() {
  const { app, scheduler, lifecycleManager, eventRepo, scrapeOrchestrator, clock } = buildApp();
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

  // Rehydrate: directly publish any PENDING_PUBLISH events whose publishAt has passed.
  // Events with a future publishAt are registered into the scheduler by the onReady hook
  // (rehydratePublishJobs), so we only need to handle the past-due ones here.
  try {
    const pending = await eventRepo.findPendingPublish();
    const now = clock.now();
    let published_now = 0;
    for (const evt of pending) {
      if (!evt.publishAt || evt.publishAt <= now) {
        await lifecycleManager.executePublish(evt.id);
        published_now++;
      }
    }
    if (pending.length > 0) {
      logger.info({ total: pending.length, published_now }, 'startup_rehydration_complete');
    }
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'startup_rehydration_failed');
  }

  // Dev seed: insert demo events if DB is empty
  if (process.env.DEV_SEED_EVENTS === '1') {
    try {
      await runDevSeed(prisma);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'dev_seed_failed');
    }
  }

  // Register the initial periodic jobs. The buildApp() tick loop handles re-registration.
  const startNow = clock.now();
  scheduler.register('scrape:tick', addMs(startNow, SCRAPE_INTERVAL_MS), {});
  scheduler.register('lifecycle:close', addMs(startNow, CLOSE_CHECK_INTERVAL_MS), {});
  scheduler.register('lifecycle:scheduleRefreshes', addMs(startNow, REFRESH_INTERVAL_MS), {});
}

start();
