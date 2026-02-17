import { PrismaClient } from '@prisma/client';
import { MediaEntity } from '../domain/types.js';

export class MediaRepository {
  constructor(private prisma: PrismaClient) {}

  async findByKey(mediaKey: string): Promise<MediaEntity | null> {
    return this.prisma.media.findUnique({ where: { mediaKey } });
  }

  async findById(id: string): Promise<MediaEntity | null> {
    return this.prisma.media.findUnique({ where: { id } });
  }

  async findAllAllowlisted(): Promise<MediaEntity[]> {
    return this.prisma.media.findMany({ where: { allowlisted: true } });
  }

  async create(data: { mediaKey: string; name: string; allowlisted: boolean }): Promise<MediaEntity> {
    return this.prisma.media.create({ data });
  }
}
