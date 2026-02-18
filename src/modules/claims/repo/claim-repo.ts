import { PrismaClient } from '@prisma/client';
import { ClaimEntity, QuoteEntity } from '../domain/types.js';

export class ClaimRepository {
  constructor(private prisma: PrismaClient) {}

  async createClaim(data: {
    eventId: string;
    versionId: string;
    claimText: string;
    claimType: string;
    status: string;
  }): Promise<ClaimEntity> {
    return this.prisma.claim.create({
      data: {
        eventId: data.eventId,
        versionId: data.versionId,
        claimText: data.claimText,
        claimType: data.claimType as any,
        status: data.status as any,
      },
    }) as Promise<ClaimEntity>;
  }

  async createQuote(data: {
    claimId: string;
    articleId: string;
    quoteText: string;
    spanStart?: number | null;
    spanEnd?: number | null;
    strength: string;
    role: string;
  }): Promise<QuoteEntity> {
    return this.prisma.quote.create({
      data: {
        claimId: data.claimId,
        articleId: data.articleId,
        quoteText: data.quoteText,
        spanStart: data.spanStart ?? null,
        spanEnd: data.spanEnd ?? null,
        strength: data.strength as any,
        role: data.role as any,
      },
    }) as Promise<QuoteEntity>;
  }

  async findClaimsByVersion(eventId: string, versionId: string): Promise<ClaimEntity[]> {
    return this.prisma.claim.findMany({
      where: { eventId, versionId },
    }) as Promise<ClaimEntity[]>;
  }

  async findClaimsWithQuotesByVersion(eventId: string, versionId: string) {
    return this.prisma.claim.findMany({
      where: { eventId, versionId },
      include: {
        quotes: {
          include: { article: { include: { media: true } } },
        },
      },
    });
  }

  async countClaimsByVersion(eventId: string, versionId: string): Promise<number> {
    return this.prisma.claim.count({ where: { eventId, versionId } });
  }

  async deleteClaimsByVersion(eventId: string, versionId: string): Promise<number> {
    // Delete quotes first (FK constraint), then claims
    const claims = await this.prisma.claim.findMany({
      where: { eventId, versionId },
      select: { id: true },
    });
    const claimIds = claims.map((c) => c.id);

    if (claimIds.length > 0) {
      await this.prisma.quote.deleteMany({ where: { claimId: { in: claimIds } } });
    }
    const result = await this.prisma.claim.deleteMany({ where: { eventId, versionId } });
    return result.count;
  }
}
