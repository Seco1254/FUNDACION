import { PrismaClient } from '@prisma/client';
import type { TopicAssignmentEntity } from '../domain/types.js';

export class TopicAssignmentRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: {
    eventId: string;
    versionId: string;
    articleId: string;
    topicKey: string;
    weight: number;
  }): Promise<TopicAssignmentEntity> {
    return this.prisma.topicAssignment.create({
      data: {
        eventId: data.eventId,
        versionId: data.versionId,
        articleId: data.articleId,
        topicKey: data.topicKey,
        weight: data.weight,
      },
    }) as unknown as Promise<TopicAssignmentEntity>;
  }

  async findByEventAndVersion(eventId: string, versionId: string): Promise<TopicAssignmentEntity[]> {
    return this.prisma.topicAssignment.findMany({
      where: { eventId, versionId },
    }) as unknown as Promise<TopicAssignmentEntity[]>;
  }

  async findByArticle(articleId: string): Promise<TopicAssignmentEntity[]> {
    return this.prisma.topicAssignment.findMany({
      where: { articleId },
    }) as unknown as Promise<TopicAssignmentEntity[]>;
  }

  async countByVersion(eventId: string, versionId: string): Promise<number> {
    return this.prisma.topicAssignment.count({
      where: { eventId, versionId },
    });
  }
}
