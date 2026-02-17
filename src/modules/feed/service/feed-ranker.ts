export interface RankableEvent {
  event_id: string;
  t_last: Date | null;
  unique_media: number;
  headline: string | null;
  previous_position: number | null;
  has_new_supported_claim: boolean;
  headline_changed: boolean;
  has_new_media: boolean;
}

export interface RankedEvent {
  event_id: string;
  score: number;
  position: number;
}

const FRESH_HALF_LIFE_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_POSITION_JUMP = 3;

export function computeFreshness(tLast: Date | null, now: Date): number {
  if (!tLast) return 0;
  const elapsed = now.getTime() - tLast.getTime();
  return Math.exp(-elapsed / FRESH_HALF_LIFE_MS);
}

export function computeDiversity(uniqueMedia: number): number {
  return Math.min(1, uniqueMedia / 5);
}

export function computeScore(event: RankableEvent, now: Date): number {
  const fresh = computeFreshness(event.t_last, now);
  const diversity = computeDiversity(event.unique_media);
  return 0.6 * fresh + 0.4 * diversity;
}

export function hasTrigger(event: RankableEvent): boolean {
  return event.headline_changed || event.has_new_supported_claim || event.has_new_media;
}

export function rankFeed(events: RankableEvent[], now: Date): RankedEvent[] {
  // Score all events
  const scored = events.map((e) => ({
    event_id: e.event_id,
    score: computeScore(e, now),
    previous_position: e.previous_position,
    triggered: hasTrigger(e),
  }));

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Apply sticky ordering: restrict movement to MAX_POSITION_JUMP unless triggered
  const result: RankedEvent[] = [];
  for (let i = 0; i < scored.length; i++) {
    const item = scored[i];
    let finalPosition = i;

    if (item.previous_position !== null && !item.triggered) {
      // Constrain movement
      const diff = Math.abs(i - item.previous_position);
      if (diff > MAX_POSITION_JUMP) {
        // Move at most MAX_POSITION_JUMP positions toward new score position
        if (i < item.previous_position) {
          finalPosition = item.previous_position - MAX_POSITION_JUMP;
        } else {
          finalPosition = item.previous_position + MAX_POSITION_JUMP;
        }
      }
    }

    result.push({
      event_id: item.event_id,
      score: item.score,
      position: finalPosition,
    });
  }

  // Sort by final position
  result.sort((a, b) => a.position - b.position);

  // Re-index positions sequentially
  for (let i = 0; i < result.length; i++) {
    result[i].position = i;
  }

  return result;
}
