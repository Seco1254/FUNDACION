import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { EventEnvelope } from './envelope.js';

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

const envelopeSchema = {
  type: 'object',
  required: ['event_name', 'event_id', 'occurred_at', 'trace', 'payload'],
  properties: {
    event_name: { type: 'string', minLength: 1 },
    event_id: { type: 'string', minLength: 1 },
    occurred_at: { type: 'string', format: 'date-time' },
    trace: {
      type: 'object',
      required: ['trace_id', 'span_id', 'source_module'],
      properties: {
        trace_id: { type: 'string', minLength: 1 },
        span_id: { type: 'string', minLength: 1 },
        source_module: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
    payload: { type: 'object' },
  },
  additionalProperties: false,
};

const validateEnvelope = ajv.compile(envelopeSchema);

export function assertValidEnvelope(envelope: unknown): asserts envelope is EventEnvelope {
  if (!validateEnvelope(envelope)) {
    const errors = validateEnvelope.errors?.map((e) => `${e.instancePath} ${e.message}`).join('; ');
    throw new Error(`Invalid event envelope: ${errors}`);
  }
}
