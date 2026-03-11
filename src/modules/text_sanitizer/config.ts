/* Text sanitizer — environment config. */

export const TEXT_SANITIZER_ENABLED = process.env.TEXT_SANITIZER_ENABLED !== '0';
export const DEBUG_TEXT_SANITIZER = process.env.DEBUG_TEXT_SANITIZER === '1';

export const TEXT_SANITIZER_NUMERIC_DENSITY_THRESHOLD = parseFloat(
  process.env.TEXT_SANITIZER_NUMERIC_DENSITY_THRESHOLD ?? '0.35',
);
export const TEXT_SANITIZER_MAX_NOISE_LINE_LEN = parseInt(
  process.env.TEXT_SANITIZER_MAX_NOISE_LINE_LEN ?? '80',
  10,
);

export const TEXT_SANITIZER_DEDUP_ENABLED =
  process.env.TEXT_SANITIZER_DEDUP_ENABLED !== '0';
export const TEXT_SANITIZER_DEDUP_JACCARD = parseFloat(
  process.env.TEXT_SANITIZER_DEDUP_JACCARD ?? '0.85',
);

export const TEXT_SANITIZER_MIN_ALPHA_CHARS = parseInt(
  process.env.TEXT_SANITIZER_MIN_ALPHA_CHARS ?? '12',
  10,
);
