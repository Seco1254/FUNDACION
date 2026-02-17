import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';

const DATABASE_URL = process.env.DATABASE_URL;
const hasDb = !!DATABASE_URL;

const describeDb = hasDb ? describe : describe.skip;

describeDb('DB integration tests', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Clean tables in order
    await prisma.eventArticle.deleteMany();
    await prisma.eventVersion.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.article.deleteMany();
    await prisma.event.deleteMany();
    await prisma.media.deleteMany();
  });

  describe('media', () => {
    it('enforces unique media_key', async () => {
      await prisma.media.create({
        data: { mediaKey: 'TEST_KEY', name: 'Test', allowlisted: true },
      });

      await expect(
        prisma.media.create({
          data: { mediaKey: 'TEST_KEY', name: 'Test 2', allowlisted: false },
        }),
      ).rejects.toThrow();
    });
  });

  describe('article', () => {
    it('enforces unique url', async () => {
      const media = await prisma.media.create({
        data: { mediaKey: 'M1', name: 'M1', allowlisted: true },
      });

      await prisma.article.create({
        data: {
          mediaId: media.id,
          url: 'https://example.com/article-1',
          title: 'Title',
          snippet: 'Snippet',
          status: 'DISCOVERED',
        },
      });

      await expect(
        prisma.article.create({
          data: {
            mediaId: media.id,
            url: 'https://example.com/article-1',
            title: 'Title 2',
            snippet: 'Snippet 2',
            status: 'DISCOVERED',
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('event_version', () => {
    it('enforces unique(event_id, version_index)', async () => {
      const event = await prisma.event.create({
        data: { state: 'DETECTED' },
      });

      await prisma.eventVersion.create({
        data: {
          eventId: event.id,
          versionIndex: 0,
          gateStatus: 'NA',
          packetJson: {},
          diffJson: {},
        },
      });

      await expect(
        prisma.eventVersion.create({
          data: {
            eventId: event.id,
            versionIndex: 0,
            gateStatus: 'PASS',
            packetJson: {},
            diffJson: {},
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('event_article', () => {
    it('enforces unique(event_id, article_id)', async () => {
      const media = await prisma.media.create({
        data: { mediaKey: 'M1', name: 'M1', allowlisted: true },
      });
      const event = await prisma.event.create({
        data: { state: 'DETECTED' },
      });
      const article = await prisma.article.create({
        data: {
          mediaId: media.id,
          url: 'https://example.com/1',
          title: 'T',
          snippet: 'S',
          status: 'DISCOVERED',
        },
      });

      await prisma.eventArticle.create({
        data: { eventId: event.id, articleId: article.id },
      });

      await expect(
        prisma.eventArticle.create({
          data: { eventId: event.id, articleId: article.id },
        }),
      ).rejects.toThrow();
    });
  });

  describe('audit_log', () => {
    it('creates audit log entries', async () => {
      const entry = await prisma.auditLog.create({
        data: {
          entityType: 'EVENT',
          entityId: 'test-id',
          action: 'HANDLER_ERROR',
          traceId: 'trace-123',
          data: { error: 'test error' },
        },
      });

      expect(entry.id).toBeDefined();
      expect(entry.entityType).toBe('EVENT');
      expect(entry.action).toBe('HANDLER_ERROR');
    });
  });
});
