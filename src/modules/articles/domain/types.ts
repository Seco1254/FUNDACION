export type ArticleStatus = 'DISCOVERED' | 'NORMALIZED' | 'POLICY_OK' | 'POLICY_BLOCKED';

export type BlockedReason =
  | 'NOT_ALLOWLISTED'
  | 'NOT_SPANISH'
  | 'NO_EXTRACT'
  | 'DUPLICATE_URL'
  | 'PARSE_FAIL';

export interface ArticleEntity {
  id: string;
  mediaId: string;
  url: string;
  publishedAt: Date | null;
  title: string;
  snippet: string;
  textNorm: string | null;
  status: ArticleStatus;
  blockedReason: BlockedReason | null;
  embeddingModel: string | null;
  embeddingVec: number[] | null;
  embeddingHash: string | null;
  createdAt: Date;
}
