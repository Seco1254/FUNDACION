import { AuditRepository } from '../repo/audit-repo.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';

export class AuditService implements AuditLogWriter {
  constructor(private repo: AuditRepository) {}

  async write(entry: {
    entity_type: string;
    entity_id: string;
    action: string;
    trace_id: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    await this.repo.create({
      entityType: entry.entity_type,
      entityId: entry.entity_id,
      action: entry.action,
      traceId: entry.trace_id,
      data: entry.data,
    });
  }
}
