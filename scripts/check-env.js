/**
 * Pre-start guard: fail fast if required env vars are missing.
 * Loads .env if present (same logic as src/env.ts) so the check
 * is accurate even when DATABASE_URL comes from .env, not the shell.
 */
import { existsSync, readFileSync } from 'node:fs';

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

const required = ['DATABASE_URL'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `\n  Missing required environment variable: ${missing.join(', ')}\n` +
    '\n  To fix:\n' +
    '    1. cp .env.example .env\n' +
    '    2. Edit .env with your DATABASE_URL\n' +
    '\n  Example:\n' +
    '    DATABASE_URL=postgresql://fundacion:fundacion@localhost:5432/fundacion?schema=public\n' +
    '\n  Or start Postgres with Docker first:\n' +
    '    docker compose up -d\n',
  );
  process.exit(1);
}
