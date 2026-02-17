export type GateStatus = 'PASS' | 'FAIL' | 'NA';

export interface EventVersionEntity {
  id: string;
  eventId: string;
  versionIndex: number;
  createdAt: Date;
  gateStatus: GateStatus;
  headline: string | null;
  packetJson: unknown;
  diffJson: unknown;
}
