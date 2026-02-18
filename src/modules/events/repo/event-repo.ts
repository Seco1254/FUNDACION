import { PrismaClient } from '@prisma/client';
import { EventEntity } from '../domain/types.js';

export class EventRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(id: string): Promise<EventEntity | null> {
    return this.prisma.event.findUnique({ where: { id } }) as Promise<EventEntity | null>;
  }

  async create(data: Partial<EventEntity> & { state?: string }): Promise<EventEntity> {
    return this.prisma.event.create({
      data: {
        state: (data.state as any) ?? 'DETECTED',
        t0: data.t0,
        tLast: data.tLast,
        publishAt: data.publishAt,
        publishedAt: data.publishedAt,
        closedAt: data.closedAt,
        canonicalEventId: data.canonicalEventId,
      },
    }) as Promise<EventEntity>;
  }

  async update(id: string, data: {
    state?: string;
    t0?: Date;
    tLast?: Date;
    publishAt?: Date;
    publishedAt?: Date;
    closedAt?: Date;
    canonicalEventId?: string | null;
  }): Promise<EventEntity> {
    return this.prisma.event.update({
      where: { id },
      data: data as any,
    }) as Promise<EventEntity>;
  }

  async updateState(id: string, state: string): Promise<EventEntity> {
    return this.prisma.event.update({
      where: { id },
      data: { state: state as any },
    }) as Promise<EventEntity>;
  }

  async findPublishedFeed(cursor?: { publishedAt: Date; eventId: string }, pageSize: number = 20) {
    const where: any = { state: 'PUBLISHED' as any };
    if (cursor) {
      where.AND = [
        {
          OR: [
            { publishedAt: { lt: cursor.publishedAt } },
            { publishedAt: cursor.publishedAt, id: { lt: cursor.eventId } },
          ],
        },
      ];
    }

    return this.prisma.event.findMany({
      where,
      orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
      take: pageSize + 1,
      include: {
        versions: {
          orderBy: { versionIndex: 'desc' },
          take: 1,
        },
      },
    });
  }

  async findByIdWithLatestVersion(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        versions: {
          orderBy: { versionIndex: 'desc' },
          take: 1,
        },
      },
    });
  }

  async linkArticle(eventId: string, articleId: string): Promise<void> {
    await this.prisma.eventArticle.upsert({
      where: { eventId_articleId: { eventId, articleId } },
      update: {},
      create: { eventId, articleId },
    });
  }

  async findCandidateEvents(since: Date): Promise<EventEntity[]> {
    return this.prisma.event.findMany({
      where: {
        state: { not: 'CLOSED' as any },
        tLast: { gte: since },
      },
    }) as Promise<EventEntity[]>;
  }

  async findArticlesForEvent(eventId: string): Promise<any[]> {
    const rows = await this.prisma.eventArticle.findMany({
      where: { eventId },
      include: { article: true },
    });
    return rows.map((r: any) => r.article);
  }

  async countArticlesForEvent(eventId: string): Promise<number> {
    return this.prisma.eventArticle.count({ where: { eventId } });
  }

  async findStaleEvents(before: Date): Promise<EventEntity[]> {
    return this.prisma.event.findMany({
      where: {
        state: { notIn: ['CLOSED' as any] },
        tLast: { lte: before },
      },
    }) as Promise<EventEntity[]>;
  }

  async findActiveEvents(): Promise<EventEntity[]> {
    return this.prisma.event.findMany({
      where: {
        state: { in: ['PUBLISHED' as any, 'UPDATING' as any, 'DORMANT' as any] },
      },
    }) as Promise<EventEntity[]>;
  }


  async findPendingPublish(): Promise<Array<{ id: string; publishAt: Date | null }>> {
    return this.prisma.event.findMany({
      where: { state: 'PENDING_PUBLISH' as any, publishAt: { not: null } },
      select: { id: true, publishAt: true },
    });
  }

  async findByIdWithDetails(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        versions: { orderBy: { versionIndex: 'desc' }, take: 1 },
        eventArticles: {
          include: { article: { include: { media: true } } },
        },
      },
    });
  }
}
