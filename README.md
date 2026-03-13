# Fundacion - Backend Foundation v0.1

Modular monolith backend for serving iOS, Android, and Web clients.

## Quickstart — Docker (recommended)

```bash
docker compose up -d          # Postgres on :5432
cp .env.example .env          # DATABASE_URL already configured
npm install
npm run db:generate
npm run db:migrate:dev
npm run db:seed
npm run start:clean           # build + start → http://localhost:3000
curl http://localhost:3000/v1/health
curl http://localhost:3000/v1/feed
```

## Quickstart — Homebrew Postgres (macOS, sin Docker)

```bash
# 1. Start Postgres (install once: brew install postgresql@16)
brew services start postgresql@16
createdb fundacion   # skip if DB already exists

# 2. Configure environment
cp .env.example .env
# Set DATABASE_URL (peer auth, no password needed for your OS user):
#   DATABASE_URL=postgresql://$USER@localhost:5432/fundacion?schema=public
# Note: quotes around the value are stripped automatically — both forms work.

# 3. Install deps + migrate + seed
npm install
npm run db:generate
npm run db:migrate:dev   # use "local_init" as migration name if prompted
npm run db:seed

# 4. Start backend (verifies env + DB before starting)
npm run dev              # http://localhost:3000 — hot-reload via tsx watch

# 5. Trigger first scrape (full pipeline — creates Events visible in /v1/feed)
curl -X POST http://localhost:3000/v1/debug/scrape/run
# Events are queued for publish (publish_at = now + 5 min).
# The scheduler ticker runs every 5 s and auto-publishes when publish_at is due.
# After ~5 min: curl http://localhost:3000/v1/feed?tab=global → items non-empty
```

**Frontend (Expo/React Native):**
```bash
cd apps/client && npm install
npm run web      # opens http://localhost:8081 (browser)
# npm run start  # Metro + QR for Expo Go on device

# Physical device (iOS/Android) — needs LAN IP instead of localhost:
# ipconfig getifaddr en0                               # find your IP
# EXPO_PUBLIC_API_BASE_URL=http://192.168.X.X:3000 npm run start
```

**Common errors and fixes:**

| Error | Fix |
|---|---|
| `port_in_use` on :3000 | `lsof -ti:3000 \| xargs kill -9` or `PORT=3001 npm run dev` |
| DB unreachable (P1001) | `brew services start postgresql@16` |
| DB not found (P1003) | `createdb fundacion` |
| Access denied (P1010) | Check `DATABASE_URL` user matches `SELECT current_user` in psql |
| Feed always empty | Trigger scrape: `curl -X POST http://localhost:3000/v1/debug/scrape/run`; wait ~5 min for auto-publish |
| `URL must start with postgresql://` | Remove quotes from DATABASE_URL in .env (or keep them — the loader now strips them automatically) |

## Prerequisites

- Node.js 20+
- Postgres 14+ (via Docker Compose **or** Homebrew / system install)

## Setup (detailed)

### 1. Start Postgres

```bash
docker compose up -d
```

This starts two Postgres instances:
- **Dev DB** on port `5432` (`fundacion` / `fundacion`)
- **Test DB** on port `5433` (`fundacion_test` / `fundacion`)

### 2. Configure environment

```bash
cp .env.example .env
```

The `.env` file is loaded automatically by both the server and guard scripts.
See `.env.example` for all available variables.

### 3. Install dependencies

```bash
npm install
```

### 4. Run migrations

```bash
npm run db:generate
npm run db:migrate:dev
```

### 5. Seed the database

```bash
npm run db:seed
```

Seeds 10 allowlisted media entries (MEDIA_1 through MEDIA_10).

### 6. Start the dev server

```bash
npm run dev
```

Server starts at `http://localhost:3000`.

If port 3000 is busy, use `PORT=3001 npm run dev`.

## One-command workflows

```bash
# Start backend + Expo web client in parallel (Ctrl+C stops both)
npm run dev:all

# Migrate + seed (add --wipe to drop everything first)
npm run reset:db
npm run reset:db -- --wipe

# End-to-end smoke test: reset → scrape → wait publish → validate feed
# Requires backend already running (npm run dev or npm run dev:all)
npm run smoke
npm run smoke -- --skip-reset   # skip DB reset step
```

`dev:all` exports fast-publish defaults (`PUBLISH_DELAY_MS=0`, `SCHEDULER_TICK_MS=3000`)
so events appear in the feed within seconds. Override via `.env` or shell.

## Available scripts

| Script              | Description                                       |
|---------------------|---------------------------------------------------|
| `npm run dev`       | Start dev server with hot reload (validates env+db)|
| `npm run dev:all`   | Start backend + Expo web client in parallel        |
| `npm run build`     | Compile TypeScript                                 |
| `npm start`         | Start production server (validates env+dist+db)    |
| `npm run start:clean` | rm dist, build, start (full clean restart)       |
| `npm test`          | Run all tests (Vitest)                             |
| `npm run lint`      | Run ESLint on src/                                 |
| `npm run db:doctor` | Check env vars + DB connectivity                   |
| `npm run db:migrate`| Run migrations (deploy)                            |
| `npm run db:migrate:dev` | Run migrations (dev)                          |
| `npm run db:seed`   | Seed the database                                  |
| `npm run db:reset`  | Reset DB (drop + migrate + seed)                   |
| `npm run db:generate` | Regenerate Prisma client                         |
| `npm run reset:db`  | Migrate + seed (safe, with optional `--wipe`)      |
| `npm run smoke`     | E2E smoke test: reset → scrape → publish → feed   |

## API Endpoints

| Method | Path               | Description                  |
|--------|--------------------|------------------------------|
| GET    | `/v1/health`       | Health check                 |
| GET    | `/v1/tabs`         | Navigation tabs              |
| GET    | `/v1/feed`         | Event feed (cursor+ranking)  |
| GET    | `/v1/events/:id`   | Event detail                 |
| GET    | `/v1/topics`       | Topics with event counts     |
| GET    | `/v1/search?q=`    | Search events by headline    |
| GET    | `/v1/metrics`      | Prometheus / JSON metrics    |

## Architecture

```
src/
  contracts/         # JSON Schemas (events + API responses)
  core/              # Event bus, scheduler, clock, logging, errors
  modules/           # Domain modules (media, articles, events, versions, audit, feed)
  api/routes/        # Fastify route handlers
  db/                # Prisma schema, client, seeds
  server.ts          # App entry point
```

## Testing

```bash
# Unit + contract tests (no DB required)
npm test

# DB integration tests require DATABASE_URL set and Postgres running
DATABASE_URL=postgresql://fundacion:fundacion@localhost:5433/fundacion_test npm test
```

## Phase 1 — Backend Product Readiness Validation

### Scraper interval (10 min)

The scraper runs automatically every 10 minutes. Configured via:

- **Code default**: `SCRAPE_INTERVAL_MS` defaults to `600000` (10 min) in `src/server.ts`
- **`.env.example`**: `SCRAPE_INTERVAL_MS=600000`
- **Override**: set `SCRAPE_INTERVAL_MS` in `.env` to any value in milliseconds

To verify the effective interval:
```bash
# Check .env value
grep SCRAPE_INTERVAL_MS .env

# Check scheduler state at runtime (requires running server)
curl -s http://localhost:3000/v1/debug/scheduler | node -e "
  let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
    const j=JSON.parse(d);
    const scrape=j.jobs?.find(j=>j.jobKey==='scrape:tick');
    console.log('scrape:tick next_run:', scrape?.runAt ?? 'not scheduled');
    console.log('tick_ms:', j.tick_ms);
  });"
```

### End-to-end pipeline validation

The `bin/smoke` script validates the complete pipeline: scrape → articles → events → publish → feed.

```bash
# Prerequisites: backend running (npm run dev) + Postgres
npm run smoke              # full: reset DB → scrape → wait publish → validate feed
npm run smoke -- --skip-reset  # skip DB reset, use existing data
```

**Expected PASS output:**
```
SMOKE TEST SUMMARY
  Articles:
    POLICY_OK:        > 0
  Events:
    PUBLISHED:        > 0
  Feed items:         > 0
  SCRAPE_INTERVAL_MS: 600000ms
  /v1/topics:         OK
  /v1/search:         OK
  Smoke test PASSED — Phase 1 criteria met
```

### Phase 1 completion criteria checklist

| Criterion | How to verify |
|-----------|--------------|
| Scraper runs every 10 min | `grep SCRAPE_INTERVAL_MS .env` → `600000` |
| Pipeline produces events automatically | `npm run smoke` → PUBLISHED > 0 |
| `/v1/feed` works | `curl localhost:3000/v1/feed` → items array |
| `/v1/topics` exists | `curl localhost:3000/v1/topics` → items array |
| `/v1/search` exists | `curl localhost:3000/v1/search?q=colombia` → items array |
| Backend stable | Server stays up during smoke test |
| `tsc` passes | `npx tsc --noEmit` → exit 0 |
| `vitest` passes | `npx vitest run` → all tests pass |
