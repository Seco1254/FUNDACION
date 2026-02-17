export interface TopicAssignmentEntity {
  id: string;
  eventId: string;
  versionId: string;
  articleId: string;
  topicKey: string;
  weight: number;
  createdAt: Date;
}

export interface HeatmapBin {
  bin_index: number;
  bin_start: string;
  bin_end: string;
  topics: Record<string, number>;
}

export interface TopicScore {
  topic_key: string;
  weight: number;
}
