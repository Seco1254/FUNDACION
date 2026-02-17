import { PrismaClient } from '@prisma/client';
import { AuditLogEntity } from '../domain/types.js';

export class AuditRepository {
  constructor(private prisma: PrismaClient) {}

  async create(data: {
    entityType: string;
    entityId: string;
    action: string;
    traceId: string;
    data: unknown;
  }): Promise<AuditLogEntity> {
    return this.prisma.auditLog.create({
      data: {
        entityType: data.entityType as any,
        entityId: data.entityId,
        action: data.action,
        traceId: data.traceId,
        data: data.data as any,
      },
    }) as Promise<AuditLogEntity>;
  }

  async findByEntityId(entityId: string): Promise<AuditLogEntity[]> {
    return this.prisma.auditLog.findMany({
      where: { entityId },
      orderBy: { occurredAt: 'desc' },
    }) as Promise<AuditLogEntity[]>;
  }
}
