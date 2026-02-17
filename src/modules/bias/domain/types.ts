export type BiasScope = 'MEDIA_LEVEL' | 'ARTICLE_LEVEL';

export interface BiasLabelEntity {
  id: string;
  scope: BiasScope;
  mediaId: string | null;
  articleId: string | null;
  eventId: string;
  versionId: string;
  labelPrimary: string;
  labelSecondary: string | null;
  intensity: number;
  confidence: number;
  rationaleJson: unknown;
  createdAt: Date;
}

export interface MediaProfileEntity {
  mediaId: string;
  profileJson: unknown;
  updatedAt: Date;
}

export interface RationaleJson {
  why_short: string;
  why_signals: string[];
  why_quotes: { quote_id: string; text: string; url: string }[];
  top_features: string[];
  signals: string[];
  evidence_refs: { type: 'quote' | 'claim' | 'article'; id: string }[];
}

export interface FeatureVector {
  emotional: number;
  critical: number;
  negation: number;
  institutional: number;
  technical: number;
  attribution: number;
  pro_gov: number;
  anti_gov: number;
}
