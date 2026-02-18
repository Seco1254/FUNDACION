import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const scriptPath = resolve(import.meta.dirname ?? '.', '../../scripts/check-db.js');

function run(env: Record<string, string>): { code: number; stderr: string } {
  try {
    execFileSync('node', [scriptPath], {
      env: { ...env, PATH: process.env.PATH, HOME: process.env.HOME ?? '' },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    return { code: 0, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stderr: Buffer };
    return { code: e.status, stderr: e.stderr.toString() };
  }
}

describe('scripts/check-db.js', () => {
  it('exits 1 with actionable message when DB is unreachable', () => {
    const result = run({
      DATABASE_URL: 'postgresql://user:pass@localhost:59999/nope',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Database unreachable');
    expect(result.stderr).toContain('docker compose up -d');
    expect(result.stderr).toContain('pg_isready');
  });

  it('error message includes host and port from DATABASE_URL', () => {
    const result = run({
      DATABASE_URL: 'postgresql://dev:secret@myhost:6543/mydb',
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('myhost:6543');
  });
});
