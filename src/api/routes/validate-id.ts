const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type IdValidation =
  | { valid: false; error: string }
  | { valid: true; id: string };

export function validateEventId(raw: string | undefined): IdValidation {
  if (!raw || raw.trim().length === 0) {
    return { valid: false, error: 'Missing event_id parameter' };
  }
  const trimmed = raw.trim();
  if (trimmed.includes('\u2026') || trimmed.includes('...')) {
    return { valid: false, error: 'event_id contains placeholder characters. Provide a real UUID.' };
  }
  if (!UUID_RE.test(trimmed)) {
    return { valid: false, error: `event_id "${trimmed}" is not a valid UUID.` };
  }
  return { valid: true, id: trimmed };
}
