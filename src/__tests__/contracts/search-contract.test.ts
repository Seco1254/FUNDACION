import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import searchSchema from '../../contracts/api/search.json';
import searchFixture from '../fixtures/search.fixture.json';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(searchSchema);

describe('Search contract', () => {
  it('fixture validates against JSON schema', () => {
    const valid = validate(searchFixture);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('SearchResultItem has summary instead of overview object', () => {
    const item = searchFixture.items[0];
    expect(typeof item.summary).toBe('string');
    expect((item as any).overview).toBeUndefined();
  });

  it('SearchResultItem has match_headline', () => {
    const item = searchFixture.items[0];
    expect(item.match_headline).toContain('<mark>');
  });

  it('schema rejects missing query', () => {
    const invalid = {
      items: [],
      next_cursor: null,
      meta: { has_more: false },
    };
    const valid = validate(invalid);
    expect(valid).toBe(false);
  });

  it('schema rejects invalid confidence_label', () => {
    const invalid = {
      items: [{
        event_id: 'e1',
        headline: 'H',
        published_at: '2026-01-01T00:00:00.000Z',
        updated_at: null,
        summary: null,
        confidence_label: 'INVALID',
        topic: null,
        sources: [],
        source_count: 0,
        article_count: 0,
        evidence_level: 'low',
        cover_image_url: null,
        match_headline: null,
      }],
      query: 'test',
      next_cursor: null,
      meta: { has_more: false },
    };
    const valid = validate(invalid);
    expect(valid).toBe(false);
  });
});
