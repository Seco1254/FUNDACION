import { existsSync, readFileSync } from 'node:fs';

/**
 * Lightweight .env loader — must be imported before any module that
 * reads process.env (e.g. Prisma, Fastify config).
 *
 * Reads .env if present. Does NOT override existing shell env vars.
 * Zero dependencies — replaces the need for the dotenv package.
 */
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
