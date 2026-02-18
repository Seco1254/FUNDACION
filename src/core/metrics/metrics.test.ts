import { describe, it, expect, beforeEach } from 'vitest';
import { metrics } from './metrics.js';

describe('MetricsCollector', () => {
  beforeEach(() => {
    metrics.reset();
  });

  it('increments counters', () => {
    metrics.incCounter('test.total');
    metrics.incCounter('test.total');
    metrics.incCounter('test.total', 3);
    expect(metrics.getCounter('test.total')).toBe(5);
  });

  it('sets and reads gauges', () => {
    metrics.setGauge('active.connections', 42);
    expect(metrics.getGauge('active.connections')).toBe(42);
    metrics.setGauge('active.connections', 10);
    expect(metrics.getGauge('active.connections')).toBe(10);
  });

  it('observes histogram and computes percentiles', () => {
    for (let i = 1; i <= 100; i++) {
      metrics.observeHistogram('request.latency', i);
    }
    const summary = metrics.getHistogramSummary('request.latency');
    expect(summary).not.toBeNull();
    expect(summary!.count).toBe(100);
    expect(summary!.p50).toBe(51);
    expect(summary!.p95).toBe(96);
    expect(summary!.p99).toBe(100);
  });

  it('returns null summary for empty histogram', () => {
    expect(metrics.getHistogramSummary('nonexistent')).toBeNull();
  });

  it('toJSON includes all metric types', () => {
    metrics.incCounter('c1');
    metrics.setGauge('g1', 5);
    metrics.observeHistogram('h1', 10);

    const json = metrics.toJSON();
    expect(json.c1).toEqual({ type: 'counter', value: 1 });
    expect(json.g1).toEqual({ type: 'gauge', value: 5 });
    expect((json.h1 as any).type).toBe('histogram');
    expect((json.h1 as any).count).toBe(1);
  });

  it('toPrometheus generates valid text format', () => {
    metrics.incCounter('test.counter');
    metrics.setGauge('test.gauge', 3);

    const text = metrics.toPrometheus();
    expect(text).toContain('# TYPE test_counter counter');
    expect(text).toContain('test_counter 1');
    expect(text).toContain('# TYPE test_gauge gauge');
    expect(text).toContain('test_gauge 3');
  });

  it('reset clears all data', () => {
    metrics.incCounter('c1');
    metrics.setGauge('g1', 1);
    metrics.reset();
    expect(metrics.getCounter('c1')).toBe(0);
    expect(metrics.getGauge('g1')).toBe(0);
    expect(metrics.toJSON()).toEqual({});
  });
});
