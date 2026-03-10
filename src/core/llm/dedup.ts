import { createHash } from 'node:crypto';

/** Bump this when prompt templates change to invalidate all cached hashes. */
export const PROMPT_VERSION = 'v3.1';

/**
 * Deterministic hash for claim-extraction inputs.
 * Inputs: sorted article IDs + their updatedAt timestamps + prompt version.
 */
export function computeClaimsHash(
  articleIds: string[],
  articleUpdatedAts: (string | null)[],
): string {
  const pairs = articleIds
    .map((id, i) => `${id}:${articleUpdatedAts[i] ?? ''}`)
    .sort();
  const payload = `claims:${PROMPT_VERSION}:${pairs.join('|')}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Deterministic hash for overview-generation inputs.
 * Inputs: version ID + claims hash (covers article content) + prompt version.
 */
export function computeOverviewHash(
  versionId: string,
  claimsHash: string,
): string {
  const payload = `overview:${PROMPT_VERSION}:${versionId}:${claimsHash}`;
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}
