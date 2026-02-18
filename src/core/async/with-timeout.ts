export class TimeoutError extends Error {
  readonly stage: string;
  readonly mediaKey: string | null;
  readonly timeoutMs: number;

  constructor(stage: string, mediaKey: string | null, timeoutMs: number) {
    super(`Timeout after ${timeoutMs}ms at stage="${stage}"${mediaKey ? ` media="${mediaKey}"` : ''}`);
    this.name = 'TimeoutError';
    this.stage = stage;
    this.mediaKey = mediaKey;
    this.timeoutMs = timeoutMs;
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  meta: { stage: string; mediaKey?: string },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(meta.stage, meta.mediaKey ?? null, ms));
    }, ms);

    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
