import { FastifyRequest, FastifyReply } from 'fastify';
import { ulid } from 'ulid';
import { logger } from './logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    traceId: string;
  }
}

export async function traceMiddleware(request: FastifyRequest, _reply: FastifyReply) {
  const traceId = (request.headers['x-trace-id'] as string) || ulid();
  request.traceId = traceId;

  request.log = logger.child({ trace_id: traceId });
  request.log.info({ method: request.method, url: request.url }, 'request_start');
}

export function onResponseHook(request: FastifyRequest, reply: FastifyReply, done: () => void) {
  request.log.info(
    {
      method: request.method,
      url: request.url,
      status: reply.statusCode,
      latency_ms: reply.elapsedTime,
    },
    'request_end',
  );
  done();
}
