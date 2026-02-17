export type EventState =
  | 'DETECTED'
  | 'PENDING_PUBLISH'
  | 'PUBLISHED'
  | 'UPDATING'
  | 'DORMANT'
  | 'CLOSED';

export interface EventEntity {
  id: string;
  state: EventState;
  t0: Date | null;
  tLast: Date | null;
  publishAt: Date | null;
  publishedAt: Date | null;
  closedAt: Date | null;
  canonicalEventId: string | null;
  createdAt: Date;
}
