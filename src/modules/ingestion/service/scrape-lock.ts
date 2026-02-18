export interface ScrapeStatus {
  running: boolean;
  started_at: string | null;
  trace_id: string | null;
  inflight_media_key: string | null;
  last_finished_at: string | null;
  last_result_summary: Record<string, unknown> | null;
  last_error: string | null;
}

export class ScrapeLock {
  private _running = false;
  private _startedAt: string | null = null;
  private _traceId: string | null = null;
  private _inflightMediaKey: string | null = null;
  private _lastFinishedAt: string | null = null;
  private _lastResultSummary: Record<string, unknown> | null = null;
  private _lastError: string | null = null;

  tryAcquire(traceId: string): boolean {
    if (this._running) return false;
    this._running = true;
    this._startedAt = new Date().toISOString();
    this._traceId = traceId;
    this._inflightMediaKey = null;
    return true;
  }

  release(result?: { summary?: Record<string, unknown>; error?: string }): void {
    this._running = false;
    this._lastFinishedAt = new Date().toISOString();
    this._inflightMediaKey = null;
    if (result?.error) {
      this._lastError = result.error;
      this._lastResultSummary = null;
    } else {
      this._lastError = null;
      this._lastResultSummary = result?.summary ?? null;
    }
  }

  setInflightMediaKey(key: string | null): void {
    this._inflightMediaKey = key;
  }

  getStatus(): ScrapeStatus {
    return {
      running: this._running,
      started_at: this._startedAt,
      trace_id: this._traceId,
      inflight_media_key: this._inflightMediaKey,
      last_finished_at: this._lastFinishedAt,
      last_result_summary: this._lastResultSummary,
      last_error: this._lastError,
    };
  }

  get startedAt(): string | null {
    return this._startedAt;
  }

  get traceId(): string | null {
    return this._traceId;
  }
}

export const scrapeLock = new ScrapeLock();
