import { PrismaClient } from '@prisma/client';
import { EventVersionEntity } from '../domain/types.js';

export class VersionRepository {
  constructor(private prisma: PrismaClient) {}

  async findLatestByEventId(eventId: string): Promise<EventVersionEntity | null> {
    return this.prisma.eventVersion.findFirst({
      where: { eventId },
      orderBy: { versionIndex: 'desc' },
    }) as Promise<EventVersionEntity | null>;
  }

  async findById(id: string): Promise<EventVersionEntity | null> {
    return this.prisma.eventVersion.findUnique({
      where: { id },
    }) as Promise<EventVersionEntity | null>;
  }

  async update(id: string, data: {
    packetJson?: unknown;
    gateStatus?: string;
  }): Promise<EventVersionEntity> {
    return this.prisma.eventVersion.update({
      where: { id },
      data: {
        ...(data.packetJson !== undefined ? { packetJson: data.packetJson as any } : {}),
        ...(data.gateStatus !== undefined ? { gateStatus: data.gateStatus as any } : {}),
      },
    }) as Promise<EventVersionEntity>;
  }

  async create(data: {
    eventId: string;
    versionIndex: number;
    gateStatus?: string;
    headline?: string | null;
    packetJson?: unknown;
    diffJson?: unknown;
  }): Promise<EventVersionEntity> {
    return this.prisma.eventVersion.create({
      data: {
        eventId: data.eventId,
        versionIndex: data.versionIndex,
        gateStatus: (data.gateStatus as any) ?? 'NA',
        headline: data.headline ?? null,
        packetJson: (data.packetJson as any) ?? {},
        diffJson: (data.diffJson as any) ?? {},
      },
    }) as Promise<EventVersionEntity>;
  }
}
