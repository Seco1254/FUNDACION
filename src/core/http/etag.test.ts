import { describe, it, expect } from 'vitest';
import { computeEtag } from './etag.js';

describe('ETag computation', () => {
  it('produces deterministic weak ETag', () => {
    const body = { items: [], next_cursor: null };
    const e1 = computeEtag(body);
    const e2 = computeEtag(body);
    expect(e1).toBe(e2);
    expect(e1).toMatch(/^W\/"[a-f0-9]{16}"$/);
  });

  it('different bodies produce different ETags', () => {
    const e1 = computeEtag({ a: 1 });
    const e2 = computeEtag({ a: 2 });
    expect(e1).not.toBe(e2);
  });

  it('handles string input', () => {
    const etag = computeEtag('hello world');
    expect(etag).toMatch(/^W\/"[a-f0-9]{16}"$/);
  });
});
