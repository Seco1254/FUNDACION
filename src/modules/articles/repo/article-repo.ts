import { PrismaClient } from '@prisma/client';
import { ArticleEntity } from '../domain/types.js';

export class ArticleRepository {
  constructor(private prisma: PrismaClient) {}

  async findById(id: string): Promise<ArticleEntity | null> {
    return this.prisma.article.findUnique({ where: { id } }) as Promise<ArticleEntity | null>;
  }

  async findByUrl(url: string): Promise<ArticleEntity | null> {
    return this.prisma.article.findUnique({ where: { url } }) as Promise<ArticleEntity | null>;
  }

  async create(data: {
    mediaId: string;
    url: string;
    title: string;
    snippet: string;
    textNorm?: string | null;
    publishedAt?: Date | null;
    status?: string;
  }): Promise<ArticleEntity> {
    return this.prisma.article.create({
      data: {
        mediaId: data.mediaId,
        url: data.url,
        title: data.title,
        snippet: data.snippet,
        textNorm: data.textNorm ?? null,
        publishedAt: data.publishedAt ?? null,
        status: (data.status as any) ?? 'DISCOVERED',
      },
    }) as Promise<ArticleEntity>;
  }

  async updateStatus(
    id: string,
    status: string,
    blockedReason?: string | null,
  ): Promise<ArticleEntity> {
    return this.prisma.article.update({
      where: { id },
      data: { status: status as any, blockedReason: blockedReason as any },
    }) as Promise<ArticleEntity>;
  }

  async updateEmbedding(
    id: string,
    data: { embeddingModel: string; embeddingHash: string; embeddingVec: number[] },
  ): Promise<ArticleEntity> {
    return this.prisma.article.update({
      where: { id },
      data: {
        embeddingModel: data.embeddingModel,
        embeddingHash: data.embeddingHash,
        embeddingVec: data.embeddingVec as any,
      },
    }) as Promise<ArticleEntity>;
  }
}
