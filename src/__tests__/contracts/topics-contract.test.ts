import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import topicsSchema from '../../contracts/api/topics.json';
import topicsFixture from '../fixtures/topics.fixture.json';
import { PRODUCT_TOPIC_KEYS } from '../../contracts/product/shared.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);
const validate = ajv.compile(topicsSchema);

describe('Topics contract', () => {
  it('fixture validates against JSON schema', () => {
    const valid = validate(topicsFixture);
    if (!valid) console.error(validate.errors);
    expect(valid).toBe(true);
  });

  it('fixture does not contain OTROS', () => {
    const keys = topicsFixture.items.map((i) => i.key);
    expect(keys).not.toContain('OTROS');
  });

  it('all fixture keys are valid ProductTopicKeys', () => {
    for (const item of topicsFixture.items) {
      expect(PRODUCT_TOPIC_KEYS.has(item.key)).toBe(true);
    }
  });

  it('schema rejects OTROS key', () => {
    const invalid = {
      items: [{ key: 'OTROS', label: 'Otros', event_count: 5 }],
    };
    const valid = validate(invalid);
    expect(valid).toBe(false);
  });

  it('schema rejects missing required fields', () => {
    const invalid = {
      items: [{ key: 'ECONOMIA' }],
    };
    const valid = validate(invalid);
    expect(valid).toBe(false);
  });
});
