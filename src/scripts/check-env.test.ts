import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const scriptPath = resolve(import.meta.dirname ?? '.', '../../scripts/check-env.js');

function run(env: Record<string, string | undefined>): { code: number; stderr: string } {
  try {
    execFileSync('node', [scriptPath], {
      env: { ...env, PATH: process.env.PATH },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stderr: '' };
  } catch (err: unknown) {
    const e = err as { status: number; stderr: Buffer };
    return { code: e.status, stderr: e.stderr.toString() };
  }
}

describe('scripts/check-env.js', () => {
  it('exits 0 when DATABASE_URL is present', () => {
    const result = run({ DATABASE_URL: 'postgresql://test@localhost/test' });
    expect(result.code).toBe(0);
  });

  it('exits 1 when DATABASE_URL is missing', () => {
    const result = run({});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
  });

  it('error message includes fix instructions', () => {
    const result = run({});
    expect(result.stderr).toContain('cp .env.example .env');
    expect(result.stderr).toContain('docker compose up -d');
  });
});
