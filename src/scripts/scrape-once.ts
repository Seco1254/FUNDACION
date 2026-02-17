import { PrismaClient } from '@prisma/client';
import { EventBus } from '../core/event_bus/dispatcher.js';
import { AuditRepository } from '../modules/audit/repo/audit-repo.js';
import { AuditService } from '../modules/audit/service/audit-service.js';
import { ArticleRepository } from '../modules/articles/repo/article-repo.js';
import { MediaRepository } from '../modules/media/repo/media-repo.js';
import { ScrapeOrchestrator } from '../modules/ingestion/service/scrape-orchestrator.js';
import { FetcherParser } from '../modules/ingestion/service/fetcher-parser.js';
import { PolicyGuard } from '../modules/ingestion/service/policy-guard.js';
import { productionFetchHtml } from '../modules/ingestion/service/fetch-html.js';
import { getScraperForMedia } from '../modules/ingestion/scrapers/registry.js';

async function main() {
  const prisma = new PrismaClient();

  try {
    const auditRepo = new AuditRepository(prisma);
    const auditService = new AuditService(auditRepo);
    const articleRepo = new ArticleRepository(prisma);
    const mediaRepo = new MediaRepository(prisma);

    const eventBus = new EventBus();
    eventBus.setAuditLogWriter(auditService);

    const fetcherParser = new FetcherParser(
      articleRepo, mediaRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
    );
    const policyGuard = new PolicyGuard(articleRepo, mediaRepo, eventBus, auditService);

    eventBus.subscribe('ArticleDiscovered', 'FetcherParser', fetcherParser.handler());
    eventBus.subscribe('ArticleNormalized', 'PolicyGuard', policyGuard.handler());

    const orchestrator = new ScrapeOrchestrator(
      mediaRepo, articleRepo, eventBus, auditService, productionFetchHtml, getScraperForMedia,
    );

    console.log('Starting scrape run...');
    const result = await orchestrator.run();
    console.log(`Scrape complete: ${result.discovered} discovered, ${result.skipped} skipped`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Scrape failed:', e);
  process.exit(1);
});
