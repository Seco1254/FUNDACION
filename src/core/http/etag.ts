import { createHash } from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Compute a weak ETag from a JSON-serializable body.
 */
export function computeEtag(body: unknown): string {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  const hash = createHash('sha256').update(json).digest('hex').slice(0, 16);
  return `W/"${hash}"`;
}

/**
 * Check If-None-Match header against computed ETag.
 * Returns true if 304 was sent (caller should stop processing).
 */
export function handleEtag(
  request: FastifyRequest,
  reply: FastifyReply,
  body: unknown,
): { etag: string; notModified: boolean } {
  const etag = computeEtag(body);
  const ifNoneMatch = request.headers['if-none-match'];

  reply.header('etag', etag);

  if (ifNoneMatch && ifNoneMatch === etag) {
    return { etag, notModified: true };
  }

  return { etag, notModified: false };
}
