export type EvidenceLevel = 'high' | 'medium' | 'low' | 'none';

/**
 * Deterministic evidence level based on source diversity and text availability.
 *
 * Rules:
 * - high:   unique_sources >= 3 AND total_usable_text_len >= 2000
 * - medium: unique_sources >= 2 AND total_usable_text_len >= 1200
 * - low:    unique_sources >= 1 AND total_usable_text_len >= 800
 * - none:   otherwise
 */
export function computeEvidenceLevel(
  uniqueSourcesCount: number,
  totalUsableTextLen: number,
): EvidenceLevel {
  if (uniqueSourcesCount >= 3 && totalUsableTextLen >= 2000) return 'high';
  if (uniqueSourcesCount >= 2 && totalUsableTextLen >= 1200) return 'medium';
  if (uniqueSourcesCount >= 1 && totalUsableTextLen >= 800) return 'low';
  return 'none';
}

/**
 * Build a human-readable diagnostic string explaining why no overview is available.
 * Returns null when overview is ready (no explanation needed).
 */
export function buildWhyNoOverview(stats: {
  overviewStatus: string;
  uniqueSourcesCount: number;
  usableArticlesCount: number;
  totalUsableTextLen: number;
  articleFailReasons: string[];
  keyFactsCount?: number;
  gateReasons?: string[];
}): string | null {
  if (stats.overviewStatus === 'ready') return null;

  const parts: string[] = [
    `unique_sources=${stats.uniqueSourcesCount}`,
    `usable_articles=${stats.usableArticlesCount}`,
    `total_text=${stats.totalUsableTextLen}`,
  ];

  if (stats.keyFactsCount !== undefined) {
    parts.push(`key_facts=${stats.keyFactsCount}`);
  }

  const uniqueReasons = [...new Set(stats.articleFailReasons)];
  if (uniqueReasons.length > 0) {
    parts.push(`fail_reasons=${uniqueReasons.join(',')}`);
  }

  if (stats.gateReasons && stats.gateReasons.length > 0) {
    parts.push(`gate=${stats.gateReasons.join(',')}`);
  }

  if (stats.overviewStatus === 'pending') {
    parts.unshift('status=pending');
  } else if (stats.overviewStatus === 'failed') {
    parts.unshift('gate_failed');
  }

  return parts.join(', ');
}
