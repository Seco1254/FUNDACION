/**
 * Pre-start guard: fail fast if required env vars are missing or invalid.
 * Loads .env if present (same logic as src/env.ts) so the check is accurate
 * even when DATABASE_URL comes from .env, not the shell.
 *
 * Sanitization rules (mirrors src/env.ts parseLine):
 *  - Strips outer double/single quotes from values
 *  - Strips inline # comments from unquoted values
 */
import { existsSync, readFileSync } from 'node:fs';

/**
 * Parse a single .env line. Mirrors src/env.ts parseLine().
 * @param {string} line
 * @returns {{ key: string; value: string } | null}
 */
function parseLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 1) return null;
  const key = trimmed.slice(0, eqIdx).trim();
  const raw = trimmed.slice(eqIdx + 1);
  const stripped = raw.trimStart();
  const firstChar = stripped[0];
  if (firstChar === '"' || firstChar === "'") {
    const closeIdx = stripped.indexOf(firstChar, 1);
    if (closeIdx !== -1) {
      return { key, value: stripped.slice(1, closeIdx) };
    }
  }
  const hashIdx = raw.indexOf('#');
  const value = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
  return { key, value };
}

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const parsed = parseLine(line);
    if (parsed && !(parsed.key in process.env)) {
      process.env[parsed.key] = parsed.value;
    }
  }
}

const dbUrl = process.env.DATABASE_URL ?? '';

if (!dbUrl) {
  console.error(
    '\n  Missing required environment variable: DATABASE_URL\n' +
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

if (!dbUrl.startsWith('postgresql://') && !dbUrl.startsWith('postgres://')) {
  // Detect if the raw value still starts with a quote (loader could not strip it)
  const hasLeadingQuote = dbUrl.startsWith('"') || dbUrl.startsWith("'");
  console.error(
    '\n  Invalid DATABASE_URL: must start with postgresql:// or postgres://\n' +
    `  Got: ${dbUrl}\n` +
    (hasLeadingQuote
      ? '  Detected outer quotes — remove them in .env or rely on auto-stripping (now supported).\n'
      : '') +
    '\n  Example:\n' +
    '    DATABASE_URL=postgresql://fundacion:fundacion@localhost:5432/fundacion?schema=public\n',
  );
  process.exit(1);
}
