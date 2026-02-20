import { describe, it, expect } from 'vitest';
import { validateEventId } from './validate-id.js';

describe('validateEventId', () => {
  it('rejects undefined', () => {
    const r = validateEventId(undefined);
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('Missing');
  });

  it('rejects empty string', () => {
    const r = validateEventId('');
    expect(r.valid).toBe(false);
  });

  it('rejects whitespace-only', () => {
    const r = validateEventId('   ');
    expect(r.valid).toBe(false);
  });

  it('rejects ellipsis placeholder (…)', () => {
    const r = validateEventId('abc…def');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('placeholder');
  });

  it('rejects three-dot placeholder (...)', () => {
    const r = validateEventId('abc...def');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('placeholder');
  });

  it('rejects non-UUID string', () => {
    const r = validateEventId('not-a-uuid');
    expect(r.valid).toBe(false);
    if (!r.valid) expect(r.error).toContain('not a valid UUID');
  });

  it('rejects partial UUID', () => {
    const r = validateEventId('550e8400-e29b-41d4-a716');
    expect(r.valid).toBe(false);
  });

  it('accepts valid UUID v4', () => {
    const r = validateEventId('550e8400-e29b-41d4-a716-446655440000');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('accepts valid UUID with uppercase', () => {
    const r = validateEventId('550E8400-E29B-41D4-A716-446655440000');
    expect(r.valid).toBe(true);
  });

  it('trims whitespace around valid UUID', () => {
    const r = validateEventId('  550e8400-e29b-41d4-a716-446655440000  ');
    expect(r.valid).toBe(true);
    if (r.valid) expect(r.id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});
