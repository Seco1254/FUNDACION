export interface EventTrace {
  trace_id: string;
  span_id: string;
  source_module: string;
}

export interface EventEnvelope<T extends Record<string, unknown> = Record<string, unknown>> {
  event_name: string;
  event_id: string;
  occurred_at: string;
  trace: EventTrace;
  payload: T;
}
