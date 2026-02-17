export type ClaimType = 'FACT' | 'ALLEGATION' | 'FORECAST' | 'OPINION' | 'QUANT';
export type ClaimStatus = 'SUPPORTED' | 'DISPUTED' | 'INSUFFICIENT';
export type QuoteStrength = 'WEAK' | 'MEDIUM' | 'STRONG';
export type QuoteRole = 'EVIDENCE' | 'ATTRIBUTION' | 'CONTEXT';

export interface ClaimEntity {
  id: string;
  eventId: string;
  versionId: string;
  claimText: string;
  claimType: ClaimType;
  status: ClaimStatus;
  createdAt: Date;
}

export interface QuoteEntity {
  id: string;
  claimId: string;
  articleId: string;
  quoteText: string;
  spanStart: number | null;
  spanEnd: number | null;
  strength: QuoteStrength;
  role: QuoteRole;
  createdAt: Date;
}
