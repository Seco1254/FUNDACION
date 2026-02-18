export { LlmClient } from './client.js';
export type { LlmClientConfig, LlmMessage, LlmResponse } from './client.js';
export { computeClaimsHash, computeOverviewHash, PROMPT_VERSION } from './dedup.js';
export { validateOverviewEvidence, validateOverviewContent, buildInsufficientOverview } from './gates.js';
export type { EvidenceValidation } from './gates.js';
export { deriveTeaser } from './teaser.js';
