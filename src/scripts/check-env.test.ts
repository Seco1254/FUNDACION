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
  it('exits 0 when DATABASE_URL uses postgresql:// protocol', () => {
    const result = run({ DATABASE_URL: 'postgresql://test@localhost/test' });
    expect(result.code).toBe(0);
  });

  it('exits 0 when DATABASE_URL uses postgres:// protocol (alias)', () => {
    const result = run({ DATABASE_URL: 'postgres://test@localhost/test' });
    expect(result.code).toBe(0);
  });

  it('exits 1 when DATABASE_URL is missing', () => {
    // Pass DATABASE_URL='' to override any value the .env file might supply
    const result = run({ DATABASE_URL: '' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('DATABASE_URL');
  });

  it('error message includes fix instructions', () => {
    // Pass DATABASE_URL='' to override any value the .env file might supply
    const result = run({ DATABASE_URL: '' });
    expect(result.stderr).toContain('cp .env.example .env');
    expect(result.stderr).toContain('docker compose up -d');
  });

  it('exits 1 when DATABASE_URL has invalid protocol (http://)', () => {
    const result = run({ DATABASE_URL: 'http://localhost/fundacion' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('postgresql://');
  });

  it('exits 1 when DATABASE_URL has invalid protocol (mysql://)', () => {
    const result = run({ DATABASE_URL: 'mysql://user:pass@localhost/db' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('postgresql://');
  });
});
