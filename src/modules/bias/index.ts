export type { BiasLabelEntity, MediaProfileEntity, RationaleJson, FeatureVector, BiasScope } from './domain/types.js';
export { BiasLabelRepository } from './repo/bias-label-repo.js';
export { MediaProfileRepository } from './repo/media-profile-repo.js';
export { BiasProfiler } from './service/bias-profiler.js';
export {
  extractFeatures,
  classifyPrimary,
  classifySecondary,
  computeIntensity,
  buildSignals,
  buildTopFeatures,
  buildRationale,
} from './service/feature-extractor.js';
