/* Quality metrics — environment config. */

export const QUALITY_BOILERPLATE_ENABLED = process.env.QUALITY_BOILERPLATE_ENABLED !== '0';
export const QUALITY_MIXED_EVENT_ENABLED = process.env.QUALITY_MIXED_EVENT_ENABLED !== '0';
export const QUALITY_SPLIT_PROXY_ENABLED = process.env.QUALITY_SPLIT_PROXY_ENABLED !== '0';

export const QUALITY_MIXED_EVENT_MAX_COHESION = parseFloat(
  process.env.QUALITY_MIXED_EVENT_MAX_COHESION ?? '0.3',
);
export const QUALITY_SPLIT_PROXY_MIN_SIM = parseFloat(
  process.env.QUALITY_SPLIT_PROXY_MIN_SIM ?? '0.75',
);
export const QUALITY_SPLIT_PROXY_MIN_ENTITY_OVERLAP = parseFloat(
  process.env.QUALITY_SPLIT_PROXY_MIN_ENTITY_OVERLAP ?? '0.15',
);
