export type { TopicAssignmentEntity, HeatmapBin, TopicScore } from './domain/types.js';
export { TopicAssignmentRepository } from './repo/topic-assignment-repo.js';
export {
  TopicAssigner,
  scoreTopicsForText,
  detectEmergentTopics,
  buildHeatmap,
} from './service/topic-assigner.js';
