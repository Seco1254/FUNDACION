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
      },
    }) as Promise<EventEntity>;
  }

  async updateState(id: string, state: string): Promise<EventEntity> {
    return this.prisma.event.update({
      where: { id },
      data: { state: state as any },
    }) as Promise<EventEntity>;
  }

  async findPublishedFeed(cursor?: { publishedAt: Date; eventId: string }, pageSize: number = 20) {
    const where = cursor
      ? {
          OR: [
            { publishedAt: { lt: cursor.publishedAt } },
            {
              publishedAt: cursor.publishedAt,
              id: { lt: cursor.eventId },
            },
          ],
        }
      : {};

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
}
