import { existsSync, readFileSync } from 'node:fs';

/**
 * Parse a single .env line into {key, value} or null.
 *
 * Rules:
 *  - Blank lines and full-line comments (# as first non-space char) → null
 *  - Splits on the FIRST '=' only (value may contain '=')
 *  - Quoted value ("…" or '…'): strips outer quotes, preserves '#' inside
 *  - Unquoted value: strips inline '#' comment (first '#'), then trims whitespace
 */
export function parseLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 1) return null;

  const key = trimmed.slice(0, eqIdx).trim();
  const raw = trimmed.slice(eqIdx + 1);

  // Detect leading quote (after optional whitespace before the value)
  const stripped = raw.trimStart();
  const firstChar = stripped[0];
  if (firstChar === '"' || firstChar === "'") {
    const closeIdx = stripped.indexOf(firstChar, 1);
    if (closeIdx !== -1) {
      // Well-formed quoted value — strip outer quotes, preserve interior
      return { key, value: stripped.slice(1, closeIdx) };
    }
  }

  // Unquoted: strip inline # comment, then trim whitespace
  const hashIdx = raw.indexOf('#');
  const value = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
  return { key, value };
}

/**
 * Lightweight .env loader — must be imported before any module that
 * reads process.env (e.g. Prisma, Fastify config).
 *
 * Reads .env if present. Does NOT override existing shell env vars.
 * Zero dependencies — replaces the need for the dotenv package.
 * Strips outer quotes from values and handles inline # comments.
 */
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const parsed = parseLine(line);
    if (parsed && !(parsed.key in process.env)) {
      process.env[parsed.key] = parsed.value;
    }
  }
}
