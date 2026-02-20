import { describe, it, expect } from 'vitest';
import { parseLine } from './env.js';

describe('parseLine', () => {
  // ── null cases ───────────────────────────────────────────────────────
  it('returns null for empty line', () => {
    expect(parseLine('')).toBeNull();
  });

  it('returns null for whitespace-only line', () => {
    expect(parseLine('   ')).toBeNull();
  });

  it('returns null for full-line comment', () => {
    expect(parseLine('# this is a comment')).toBeNull();
    expect(parseLine('  # indented comment')).toBeNull();
  });

  it('returns null when no = sign', () => {
    expect(parseLine('NOEQUALS')).toBeNull();
  });

  // ── basic parsing ────────────────────────────────────────────────────
  it('parses simple KEY=value', () => {
    expect(parseLine('PORT=3000')).toEqual({ key: 'PORT', value: '3000' });
  });

  it('splits on FIRST = only (value may contain =)', () => {
    expect(parseLine('KEY=a=b=c')).toEqual({ key: 'KEY', value: 'a=b=c' });
  });

  it('trims whitespace around unquoted value', () => {
    expect(parseLine('KEY=  hello  ')).toEqual({ key: 'KEY', value: 'hello' });
  });

  it('strips inline # comment from unquoted value', () => {
    expect(parseLine('LOG_LEVEL=info # set to debug for verbose')).toEqual({
      key: 'LOG_LEVEL',
      value: 'info',
    });
  });

  // ── OBJ-1: quote stripping ───────────────────────────────────────────
  it('strips double quotes from DATABASE_URL', () => {
    expect(
      parseLine('DATABASE_URL="postgresql://guaro@localhost:5432/fundacion?schema=public"'),
    ).toEqual({
      key: 'DATABASE_URL',
      value: 'postgresql://guaro@localhost:5432/fundacion?schema=public',
    });
  });

  it('strips single quotes from DATABASE_URL', () => {
    expect(
      parseLine("DATABASE_URL='postgresql://guaro@localhost:5432/fundacion?schema=public'"),
    ).toEqual({
      key: 'DATABASE_URL',
      value: 'postgresql://guaro@localhost:5432/fundacion?schema=public',
    });
  });

  it('strips double quotes with spaces before value', () => {
    expect(parseLine('KEY=  "the value"')).toEqual({ key: 'KEY', value: 'the value' });
  });

  it('preserves # inside double-quoted value', () => {
    expect(parseLine('KEY="value#with#hash"')).toEqual({ key: 'KEY', value: 'value#with#hash' });
  });

  it('preserves = inside double-quoted value', () => {
    expect(parseLine('KEY="a=b=c"')).toEqual({ key: 'KEY', value: 'a=b=c' });
  });

  it('handles postgresql URL with query params (unquoted)', () => {
    expect(parseLine('DATABASE_URL=postgresql://u@h/db?schema=public')).toEqual({
      key: 'DATABASE_URL',
      value: 'postgresql://u@h/db?schema=public',
    });
  });

  it('handles postgres:// protocol', () => {
    expect(parseLine('DATABASE_URL=postgres://user:pass@localhost/db')).toEqual({
      key: 'DATABASE_URL',
      value: 'postgres://user:pass@localhost/db',
    });
  });
});
