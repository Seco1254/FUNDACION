import { PrismaClient } from '@prisma/client';
import type { MediaProfileEntity } from '../domain/types.js';

export class MediaProfileRepository {
  constructor(private prisma: PrismaClient) {}

  async findByMediaId(mediaId: string): Promise<MediaProfileEntity | null> {
    return this.prisma.mediaProfile.findUnique({
      where: { mediaId },
    }) as unknown as Promise<MediaProfileEntity | null>;
  }

  async upsert(mediaId: string, profileJson: unknown): Promise<MediaProfileEntity> {
    return this.prisma.mediaProfile.upsert({
      where: { mediaId },
      create: { mediaId, profileJson: profileJson as any },
      update: { profileJson: profileJson as any },
    }) as unknown as Promise<MediaProfileEntity>;
  }
}
