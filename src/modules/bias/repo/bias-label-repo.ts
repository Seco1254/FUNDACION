import { PrismaClient } from '@prisma/client';
import type { BiasLabelEntity, BiasScope } from '../domain/types.js';

export class BiasLabelRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: {
    scope: BiasScope;
    mediaId?: string | null;
    articleId?: string | null;
    eventId: string;
    versionId: string;
    labelPrimary: string;
    labelSecondary?: string | null;
    intensity: number;
    confidence: number;
    rationaleJson: unknown;
  }): Promise<BiasLabelEntity> {
    return this.prisma.biasLabel.create({
      data: {
        scope: data.scope as any,
        mediaId: data.mediaId ?? null,
        articleId: data.articleId ?? null,
        eventId: data.eventId,
        versionId: data.versionId,
        labelPrimary: data.labelPrimary,
        labelSecondary: data.labelSecondary ?? null,
        intensity: data.intensity,
        confidence: data.confidence,
        rationaleJson: data.rationaleJson as any,
      },
    }) as unknown as Promise<BiasLabelEntity>;
  }

  async findByEventAndVersion(eventId: string, versionId: string): Promise<BiasLabelEntity[]> {
    return this.prisma.biasLabel.findMany({
      where: { eventId, versionId },
    }) as unknown as Promise<BiasLabelEntity[]>;
  }

  async findMediaLevelByEvent(eventId: string, versionId: string): Promise<BiasLabelEntity[]> {
    return this.prisma.biasLabel.findMany({
      where: { eventId, versionId, scope: 'MEDIA_LEVEL' as any },
    }) as unknown as Promise<BiasLabelEntity[]>;
  }

  async findArticleLevelByEvent(eventId: string, versionId: string): Promise<BiasLabelEntity[]> {
    return this.prisma.biasLabel.findMany({
      where: { eventId, versionId, scope: 'ARTICLE_LEVEL' as any },
    }) as unknown as Promise<BiasLabelEntity[]>;
  }

  async findByMediaAndEvent(mediaId: string, eventId: string): Promise<BiasLabelEntity[]> {
    return this.prisma.biasLabel.findMany({
      where: { mediaId, eventId },
    }) as unknown as Promise<BiasLabelEntity[]>;
  }

  async countByVersion(eventId: string, versionId: string): Promise<number> {
    return this.prisma.biasLabel.count({
      where: { eventId, versionId },
    });
  }
}
