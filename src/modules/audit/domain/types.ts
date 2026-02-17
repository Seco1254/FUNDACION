export type AuditEntityType =
  | 'ARTICLE'
  | 'EVENT'
  | 'EVENT_VERSION'
  | 'MERGE'
  | 'SUB_EVENT'
  | 'OVERVIEW';

export interface AuditLogEntity {
  id: string;
  occurredAt: Date;
  entityType: AuditEntityType;
  entityId: string;
  action: string;
  traceId: string;
  data: unknown;
}
