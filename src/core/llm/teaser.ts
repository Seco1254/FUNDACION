/**
 * Derive a short teaser (max 140 chars) from ai_overview.what_happened bullets.
 */
export function deriveTeaser(
  whatHappened: string[] | null | undefined,
  maxLen = 140,
): string {
  if (!whatHappened || whatHappened.length === 0) return '';

  const joined = whatHappened
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (joined.length === 0) return '';
  if (joined.length <= maxLen) return joined;

  // Truncate at last space before limit, append ellipsis
  const cut = joined.slice(0, maxLen - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const boundary = lastSpace > maxLen * 0.5 ? lastSpace : maxLen - 1;
  return joined.slice(0, boundary).trimEnd() + '\u2026';
}
