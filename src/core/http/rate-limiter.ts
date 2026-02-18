import { FastifyRequest, FastifyReply, HookHandlerDoneFunction } from 'fastify';

export interface RateLimitConfig {
  windowMs: number;   // sliding window in ms
  max: number;        // max requests per window
}

interface BucketEntry {
  count: number;
  resetAt: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: 60_000,  // 1 minute
  max: 60,           // 60 req/min
};

export class RateLimiter {
  private buckets = new Map<string, BucketEntry>();
  private config: RateLimitConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Periodic cleanup every 2 minutes
    this.cleanupTimer = setInterval(() => this.cleanup(), 120_000);
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  private getClientIp(request: FastifyRequest): string {
    const xff = request.headers['x-forwarded-for'];
    if (typeof xff === 'string') return xff.split(',')[0].trim();
    return request.ip ?? '0.0.0.0';
  }

  hook() {
    return (request: FastifyRequest, reply: FastifyReply, done: HookHandlerDoneFunction) => {
      const ip = this.getClientIp(request);
      const now = Date.now();
      let bucket = this.buckets.get(ip);

      if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + this.config.windowMs };
        this.buckets.set(ip, bucket);
      }

      bucket.count++;

      const remaining = Math.max(0, this.config.max - bucket.count);
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);

      reply.header('x-ratelimit-limit', this.config.max);
      reply.header('x-ratelimit-remaining', remaining);
      reply.header('x-ratelimit-reset', Math.ceil(bucket.resetAt / 1000));

      if (bucket.count > this.config.max) {
        reply.header('retry-after', retryAfter);
        reply.status(429).send({
          error: 'Too Many Requests',
          retry_after_seconds: retryAfter,
        });
        return;
      }

      done();
    };
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [ip, bucket] of this.buckets) {
      if (now > bucket.resetAt) {
        this.buckets.delete(ip);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.buckets.clear();
  }
}
