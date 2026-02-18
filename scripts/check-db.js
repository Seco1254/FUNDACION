/**
 * Pre-start guard: verify the database is reachable.
 * Runs AFTER check-env.js so DATABASE_URL is guaranteed to exist.
 *
 * Detects:
 *   P1001 — DB server unreachable (not running / wrong host:port)
 *   P1003 — Database does not exist (need createdb)
 *   P1010 — Access denied (wrong user/password or missing GRANT)
 *   P1000 — Authentication failed (wrong password)
 *   Generic — any other connection error
 */
import { existsSync, readFileSync } from 'node:fs';

// ── load .env (mirrors src/env.ts parseLine — strips quotes, inline comments) ──
/** @param {string} line @returns {{ key: string; value: string } | null} */
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
    if (closeIdx !== -1) return { key, value: stripped.slice(1, closeIdx) };
  }
  const hashIdx = raw.indexOf('#');
  const value = (hashIdx === -1 ? raw : raw.slice(0, hashIdx)).trim();
  return { key, value };
}

if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf-8').split('\n')) {
    const parsed = parseLine(line);
    if (parsed && !(parsed.key in process.env)) process.env[parsed.key] = parsed.value;
  }
}

// ── parse host:port/db from DATABASE_URL for error messages ─────────
function parseDbUrl(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: u.port || '5432', db: u.pathname.slice(1).split('?')[0], user: u.username };
  } catch {
    return { host: 'localhost', port: '5432', db: 'fundacion', user: 'unknown' };
  }
}

const dbUrl = process.env.DATABASE_URL ?? '';
const { host, port, db, user } = parseDbUrl(dbUrl);

// ── connect and SELECT 1 ───────────────────────────────────────────
async function checkDb() {
  // Dynamic import so the script fails gracefully if prisma client
  // hasn't been generated yet.
  let PrismaClient;
  try {
    const mod = await import('@prisma/client');
    PrismaClient = mod.PrismaClient;
  } catch {
    console.error(
      '\n  Prisma Client not generated.\n' +
      '\n  Run:\n' +
      '    npx prisma generate\n',
    );
    process.exit(1);
  }

  const prisma = new PrismaClient({ datasourceUrl: dbUrl });

  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    await prisma.$disconnect();
  } catch (err) {
    await prisma.$disconnect().catch(() => {});

    const code = err?.code ?? '';
    const msg = err?.message ?? String(err);

    if (code === 'P1001' || msg.includes('Can\'t reach database')) {
      console.error(
        `\n  Database unreachable at ${host}:${port}\n` +
        '\n  Possible fixes:\n' +
        '    # With Docker:\n' +
        '    docker compose up -d\n' +
        '\n    # With Homebrew Postgres (macOS):\n' +
        '    brew services start postgresql@16\n' +
        '\n    # Check if Postgres is running:\n' +
        `    pg_isready -h ${host} -p ${port}\n`,
      );
    } else if (code === 'P1003' || msg.includes('does not exist')) {
      console.error(
        `\n  Database "${db}" does not exist on ${host}:${port}\n` +
        '\n  To create it:\n' +
        `    createdb -h ${host} -p ${port} -U ${user} ${db}\n` +
        '\n    # Then run migrations:\n' +
        '    npm run db:migrate:dev\n',
      );
    } else if (code === 'P1010' || msg.includes('denied')) {
      console.error(
        `\n  Access denied for user "${user}" on database "${db}"\n` +
        '\n  To fix (run as Postgres superuser):\n' +
        `    psql -h ${host} -p ${port} -U postgres -c "CREATE USER ${user} WITH PASSWORD '${user}';"\n` +
        `    psql -h ${host} -p ${port} -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE ${db} TO ${user};"\n` +
        `    psql -h ${host} -p ${port} -U postgres -c "ALTER DATABASE ${db} OWNER TO ${user};"\n`,
      );
    } else if (code === 'P1000' || msg.includes('authentication') || msg.includes('password')) {
      console.error(
        `\n  Authentication failed for user "${user}"\n` +
        '\n  Check your DATABASE_URL password in .env:\n' +
        `    Current: ${dbUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}\n` +
        '\n  To reset the password:\n' +
        `    psql -h ${host} -p ${port} -U postgres -c "ALTER USER ${user} WITH PASSWORD 'newpassword';"\n`,
      );
    } else {
      console.error(
        `\n  Database connection failed: ${msg}\n` +
        `\n  DATABASE_URL: ${dbUrl.replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@')}\n` +
        '\n  Troubleshoot:\n' +
        `    1. Is Postgres running?  pg_isready -h ${host} -p ${port}\n` +
        `    2. Does DB exist?        psql -h ${host} -p ${port} -U ${user} -l\n` +
        '    3. Run diagnostics:      npm run db:doctor\n',
      );
    }

    process.exit(1);
  }
}

await checkDb();
