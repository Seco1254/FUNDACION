export interface ScrapeStatus {
  running: boolean;
  started_at: string | null;
  trace_id: string | null;
  inflight_media_key: string | null;
  inflight_stage: string | null;
  inflight_url: string | null;
  duration_so_far_ms: number | null;
  last_finished_at: string | null;
  last_result_summary: Record<string, unknown> | null;
  last_error: string | null;
}

export class ScrapeLock {
  private _running = false;
  private _startedAt: string | null = null;
  private _traceId: string | null = null;
  private _inflightMediaKey: string | null = null;
  private _inflightStage: string | null = null;
  private _inflightUrl: string | null = null;
  private _lastFinishedAt: string | null = null;
  private _lastResultSummary: Record<string, unknown> | null = null;
  private _lastError: string | null = null;

  tryAcquire(traceId: string): boolean {
    if (this._running) return false;
    this._running = true;
    this._startedAt = new Date().toISOString();
    this._traceId = traceId;
    this._inflightMediaKey = null;
    this._inflightStage = null;
    this._inflightUrl = null;
    return true;
  }

  release(result?: { summary?: Record<string, unknown>; error?: string }): void {
    this._running = false;
    this._lastFinishedAt = new Date().toISOString();
    this._inflightMediaKey = null;
    this._inflightStage = null;
    this._inflightUrl = null;
    if (result?.error) {
      this._lastError = result.error;
      this._lastResultSummary = null;
    } else {
      this._lastError = null;
      this._lastResultSummary = result?.summary ?? null;
    }
  }

  /** Update all three inflight fields atomically. */
  setInflight(mediaKey: string | null, stage: string | null, url?: string | null): void {
    this._inflightMediaKey = mediaKey;
    this._inflightStage = stage;
    this._inflightUrl = url ?? null;
  }

  /** Backward-compat: only update the media key. */
  setInflightMediaKey(key: string | null): void {
    this._inflightMediaKey = key;
  }

  getStatus(): ScrapeStatus {
    return {
      running: this._running,
      started_at: this._startedAt,
      trace_id: this._traceId,
      inflight_media_key: this._inflightMediaKey,
      inflight_stage: this._inflightStage,
      inflight_url: this._inflightUrl,
      duration_so_far_ms:
        this._running && this._startedAt
          ? Date.now() - new Date(this._startedAt).getTime()
          : null,
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
