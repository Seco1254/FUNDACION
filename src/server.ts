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

  // Services
  const feedService = new FeedService(feedRepo);
  const auditService = new AuditService(auditRepo);

  // Event bus
  const eventBus = new EventBus();
  eventBus.setAuditLogWriter(auditService);

  // Scheduler
  const clock = new RealClock();
  const _scheduler = new Scheduler(clock, async (job) => {
    logger.info({ jobKey: job.jobKey }, 'scheduler_job_stub');
  });

  // Routes
  app.register(healthRoutes);
  app.register(tabsRoutes);
  app.register(feedRoutes(feedService));
  app.register(eventDetailRoutes(eventRepo));

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
