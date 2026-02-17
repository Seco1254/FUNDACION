# Fundacion - Backend Foundation v0.1

Modular monolith backend for serving iOS, Android, and Web clients.

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (for Postgres)

## Setup

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

Default `DATABASE_URL`:
```
postgresql://fundacion:fundacion@localhost:5432/fundacion?schema=public
```

### 3. Install dependencies

```bash
npm install
```

### 4. Run migrations

```bash
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

## Available scripts

| Script              | Description                          |
|---------------------|--------------------------------------|
| `npm run dev`       | Start dev server with hot reload     |
| `npm run build`     | Compile TypeScript                   |
| `npm start`         | Start production server              |
| `npm test`          | Run all tests (Vitest)               |
| `npm run db:migrate`| Run migrations (deploy)              |
| `npm run db:migrate:dev` | Run migrations (dev)            |
| `npm run db:seed`   | Seed the database                    |
| `npm run db:reset`  | Reset DB (drop + migrate + seed)     |
| `npm run db:generate` | Regenerate Prisma client           |

## API Endpoints

| Method | Path               | Description         |
|--------|--------------------|--------------------|
| GET    | `/v1/health`       | Health check        |
| GET    | `/v1/tabs`         | Navigation tabs     |
| GET    | `/v1/feed`         | Event feed (cursor) |
| GET    | `/v1/events/:id`   | Event detail        |

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
