/**
 * Lightweight in-process metrics collector.
 * Exports counters, gauges, and histograms in JSON format.
 * Optionally renders Prometheus text format.
 */

export interface MetricEntry {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels?: Record<string, string>;
}

class MetricsCollector {
  private counters = new Map<string, number>();
  private gauges = new Map<string, number>();
  private histograms = new Map<string, number[]>();

  // ── Counters ──
  incCounter(name: string, delta = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + delta);
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  // ── Gauges ──
  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  getGauge(name: string): number {
    return this.gauges.get(name) ?? 0;
  }

  // ── Histograms (store raw values, compute percentiles on read) ──
  observeHistogram(name: string, value: number): void {
    const arr = this.histograms.get(name) ?? [];
    arr.push(value);
    // Keep max 1000 observations (sliding)
    if (arr.length > 1000) arr.shift();
    this.histograms.set(name, arr);
  }

  getHistogramSummary(name: string): { count: number; p50: number; p95: number; p99: number } | null {
    const arr = this.histograms.get(name);
    if (!arr || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
    };
  }

  // ── Snapshot ──
  toJSON(): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    // Counters
    for (const [name, value] of this.counters) {
      result[name] = { type: 'counter', value };
    }

    // Gauges
    for (const [name, value] of this.gauges) {
      result[name] = { type: 'gauge', value };
    }

    // Histograms
    for (const [name] of this.histograms) {
      const summary = this.getHistogramSummary(name);
      if (summary) {
        result[name] = { type: 'histogram', ...summary };
      }
    }

    return result;
  }

  toPrometheus(): string {
    const lines: string[] = [];

    for (const [name, value] of this.counters) {
      const safeName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${safeName} counter`);
      lines.push(`${safeName} ${value}`);
    }

    for (const [name, value] of this.gauges) {
      const safeName = name.replace(/\./g, '_');
      lines.push(`# TYPE ${safeName} gauge`);
      lines.push(`${safeName} ${value}`);
    }

    for (const [name] of this.histograms) {
      const summary = this.getHistogramSummary(name);
      if (summary) {
        const safeName = name.replace(/\./g, '_');
        lines.push(`# TYPE ${safeName} summary`);
        lines.push(`${safeName}{quantile="0.5"} ${summary.p50}`);
        lines.push(`${safeName}{quantile="0.95"} ${summary.p95}`);
        lines.push(`${safeName}{quantile="0.99"} ${summary.p99}`);
        lines.push(`${safeName}_count ${summary.count}`);
      }
    }

    return lines.join('\n') + '\n';
  }

  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }
}

// Singleton
export const metrics = new MetricsCollector();
