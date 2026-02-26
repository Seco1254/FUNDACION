export type ArticleStatus = 'DISCOVERED' | 'NORMALIZED' | 'POLICY_OK' | 'POLICY_BLOCKED';

export type BlockedReason =
  | 'NOT_ALLOWLISTED'
  | 'NOT_SPANISH'
  | 'NO_EXTRACT'
  | 'DUPLICATE_URL'
  | 'PARSE_FAIL';

export type TextContentSource = 'body' | 'meta' | 'none';
export type ExtractionFailReason = 'paywall' | 'blocked' | 'parse_error' | 'empty' | 'too_short' | 'unknown';
export type RoutingDecision = 'NEWS' | 'LOW_CONFIDENCE' | 'NON_NEWS';

export interface ArticleEntity {
  id: string;
  mediaId: string;
  url: string;
  publishedAt: Date | null;
  title: string;
  snippet: string;
  textNorm: string | null;
  textContentLen: number | null;
  textContentSource: string | null;
  extractionFailReason: string | null;
  paywallDetected: boolean;
  usableForOverview: boolean;
  contentType: string | null;
  contentTypeScore: number | null;
  routingDecision: string | null;
  status: ArticleStatus;
  blockedReason: BlockedReason | null;
  embeddingModel: string | null;
  embeddingVec: number[] | null;
  embeddingHash: string | null;
  createdAt: Date;
}
