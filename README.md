# Fundacion

Modular monolith backend for a Colombian news aggregation platform.
Scrapes allowlisted media outlets, clusters articles into events, extracts
claims, generates overviews, and serves a curated feed to iOS/Android/Web
clients via a REST API.

## Architecture

```
src/
  api/routes/           Fastify route handlers (public + debug)
  constants/            Shared constants
  contracts/            JSON Schemas (events + API responses)
  core/
    async/              Timeout helpers
    cache/              In-memory cache + singleflight + invalidation
    errors/             Error types
    event_bus/          In-process pub/sub (EventBus + dispatcher)
    http/               Rate limiter, ETag
    llm/                Anthropic client, publish gate, dedup, teaser
    logging/            Pino logger + trace middleware
    metrics/            Prometheus-style metrics + subscribers
    scheduler/          In-memory job scheduler + rehydration
    time/               Clock abstraction (real + fake for tests)
  db/
    prisma/             Schema, migrations
    seeds/              seed.ts (full), seed-media.ts (minimal)
  modules/
    articles/           Article model, repo
    audit/              Audit log (every pipeline action traced)
    bias/               Media/article-level bias profiling
    claims/             Claim + Quote extraction (LLM or heuristic)
    embedding/          Hash-based embedding vectors (no GPU)
    event_linker/       Pair scoring, hard-negative gates, split detector
    events/             Event model, repo, coherence gate
    feed/               Feed query, ranking, pagination
    ingestion/          Scrapers, fetcher-parser, policy guard, content router
    lifecycle/          Publish scheduling, close/refresh jobs
    media/              Media model, repo
    overview/           AI overview generation (LLM or text fallback)
    quality/            Boilerplate, mixed-event, split-proxy detectors
    ranking/            Feed ranking (Q formula)
    subevents/          Sub-event detection via topic drift
    text_sanitizer/     DOM cleaner, text sanitizer, content classifier
    topics/             Topic assignment + heatmap
    versioning/         Immutable event version snapshots
  scripts/              CLI helpers (scrape-once, link-once, dev-seed)
  server.ts             Entry point: Fastify app + event bus wiring
```

### Pipeline flow

```
Scrape (scheduler, every 15 min)
  -> ArticleDiscovered
    -> FetcherParser: fetch HTML, DOM clean, parse, classify, route
      -> ArticleNormalized
        -> PolicyGuard: allowlist, language, length checks
          -> ArticlePolicyOk
            -> EmbeddingService: hash-based embedding vector
              -> ArticleEmbedded
                -> EventLinkerV2: pair scoring + gates + split detection
                  -> EventCreated (new) or ArticleLinkedToEvent (existing)
                    -> LifecycleManager: schedule publish (5 min delay)
                    -> VersioningHandler: create EventVersion snapshot
                      -> ClaimQuoteExtractor: extract claims + quotes
                        -> OverviewGenerator: coherence gate + AI overview
                          -> TopicAssigner + BiasProfiler (parallel)
                            -> SubEventBuilder
  (after publish delay)
  -> EventPublished -> appears in /v1/feed
```

## Prerequisites

- **Node.js 20+**
- **PostgreSQL 14+** (Docker Compose or system install)

## Quickstart (Docker)

```bash
docker compose up -d          # Postgres on :5432 + test DB on :5433
cp .env.example .env          # DATABASE_URL already configured
npm install
npm run db:generate
npm run db:migrate:dev        # "primera" if prompted for migration name
npm run db:seed
npm run dev                   # http://localhost:3000 (hot reload)

# Verify
curl http://localhost:3000/v1/health
# {"ok":true,"timestamp":"..."}

# Trigger scrape + wait 5 min for publish
curl -X POST http://localhost:3000/v1/debug/scrape/run
# After ~5 min:
curl http://localhost:3000/v1/feed?tab=global
```

## Quickstart (macOS Homebrew Postgres)

```bash
brew services start postgresql@16
createdb fundacion             # skip if DB exists

cp .env.example .env
# Edit DATABASE_URL:
#   DATABASE_URL=postgresql://$USER@localhost:5432/fundacion?schema=public

npm install
npm run db:generate
npm run db:migrate:dev
npm run db:seed
npm run dev
```

## Populating the feed

Events are not instantly visible in the feed. The pipeline requires:

1. **Scrape** articles from allowlisted media:
   ```bash
   curl -X POST http://localhost:3000/v1/debug/scrape/run
   ```
2. **Wait for publish delay** (default 5 min = `PUBLISH_DELAY_MS=300000`).
   The scheduler auto-publishes when `publishAt` is due.
3. **Check the feed**:
   ```bash
   curl http://localhost:3000/v1/feed?tab=global
   ```

**For faster local iteration**, use `dev:api` or `dev:all`:

```bash
npm run dev:api     # PUBLISH_DELAY_MS=30000 (30 s)
npm run dev:all     # PUBLISH_DELAY_MS=0, SCHEDULER_TICK_MS=3000 (instant)
```

Or override in `.env`:
```
SCHEDULER_TICK_MS=5000
PUBLISH_DELAY_MS=30000
```

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start dev server with hot reload (validates env + DB first) |
| `npm run dev:api` | Dev server with 30 s publish delay (no env/DB checks) |
| `npm run dev:all` | Backend + Expo web client in parallel (instant publish) |
| `npm run dev:client` | Expo client only (`apps/client`) |
| `npm run build` | Compile TypeScript (`tsc`) |
| `npm start` | Production server (validates env + dist + DB) |
| `npm run start:clean` | Clean dist, rebuild, start |
| `npm test` | Run all tests (`vitest run`) |
| `npm run test:watch` | Tests in watch mode |
| `npm run lint` | ESLint on `src/` |
| `npm run format` | Prettier on `src/**/*.ts` |
| `npm run db:doctor` | Check env vars + DB connectivity diagnostics |
| `npm run db:generate` | Regenerate Prisma client from schema |
| `npm run db:migrate` | Run migrations (deploy, production) |
| `npm run db:migrate:dev` | Run migrations (dev, creates migration files) |
| `npm run db:seed` | Seed DB with 10 allowlisted media outlets |
| `npm run db:seed:minimal` | Seed media-only (no demo data) |
| `npm run db:reset` | Drop + migrate + seed (`prisma migrate reset --force`) |
| `npm run scrape:once` | Run one scrape cycle from CLI (no server needed) |
| `npm run link:once` | Run one linker pass from CLI |
| `npm run reset:db` | Migrate + seed (safe, optional `--wipe` flag) |
| `npm run smoke` | E2E smoke test: reset -> scrape -> publish -> feed |
| `npm run debug:ui` | Quick diagnostic: health + feed + gate stats |
| `npm run db:backfill:coherence` | Backfill legacy coherence metrics (dry-run; add `-- --apply` to write) |
| `npm run debug:coherence:canary` | Canary report: PASS/FAIL bins, percentiles, warnings (CLI, no server) |

### Shell helpers (bin/)

| Script | Description |
|---|---|
| `./bin/reset-db` | Migrate + seed (with Postgres connectivity check) |
| `./bin/reset-db --wipe` | Full reset: drop all tables, migrate, seed |
| `./bin/smoke` | E2E smoke: reset -> scrape -> wait publish -> validate feed |
| `./bin/smoke --skip-reset` | Smoke without DB reset |
| `./bin/debug-ui` | Health + feed + gate stats diagnostic |
| `./bin/dev-all` | Backend + Expo client (fast-publish defaults) |

## Environment variables

All variables are documented in `.env.example`. Key groups:

### Required

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | (none) | PostgreSQL connection string |

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `LOG_LEVEL` | `info` | Pino log level |
| `REQUEST_TIMEOUT_MS` | `30000` | HTTP request timeout |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit window |
| `RATE_LIMIT_MAX` | `60` | Max requests per window |
| `CACHE_MAX_ENTRIES` | `500` | In-memory cache size |
| `CACHE_DEFAULT_TTL_MS` | `30000` | Cache TTL |

### Scheduler

| Variable | Default | Description |
|---|---|---|
| `SCHEDULER_TICK_MS` | `30000` | Scheduler loop interval |
| `SCRAPE_INTERVAL_MS` | `900000` (15 min) | Scrape frequency |
| `PUBLISH_DELAY_MS` | `300000` (5 min) | Delay before publishing new events |
| `CLOSE_CHECK_INTERVAL_MS` | `21600000` (6 h) | Stale event close check |
| `REFRESH_INTERVAL_MS` | `1800000` (30 min) | Active event refresh |

### Scraping

| Variable | Default | Description |
|---|---|---|
| `SCRAPE_TIMEOUT_MS` | `60000` | Overall scrape timeout |
| `SCRAPE_MEDIA_TIMEOUT_MS` | `25000` | Per-media scrape timeout |
| `FETCH_TIMEOUT_MS` | `12000` | HTTP fetch timeout |
| `ARTICLE_TEXT_MIN_LEN` | `800` | Min article text length (body-grade) |
| `ARTICLE_MIN_LEN_META` | `200` | Min article text length (meta fallback) |

### Event linker

| Variable | Default | Description |
|---|---|---|
| `THETA_AUTO_LINK` | `0.45` | Auto-link threshold |
| `THETA_MAYBE_LINK` | `0.30` | Maybe-link threshold |
| `DISABLE_AUTO_LINK` | `0` | Kill switch: disable auto-linking |
| `EVENT_LINKER_CANDIDATE_WINDOW_HOURS` | `72` | Primary candidate window |
| `EVENT_LINKER_FALLBACK_WINDOW_DAYS` | `7` | Fallback candidate window |

### Hard negative gates (v2.1)

| Variable | Default | Description |
|---|---|---|
| `EVENT_LINKER_HARD_NEGATIVE_ENABLED` | `1` | Enable all hard-negative gates |
| `EVENT_LINKER_AUTO_MIN_ENTITY_JACCARD` | `0.05` | Entity gate: auto-link threshold |
| `EVENT_LINKER_MAYBE_MIN_ENTITY_JACCARD` | `0.01` | Entity gate: maybe-link threshold |
| `EVENT_LINKER_TOPIC_GATE_ENABLED` | `1` | Topic mismatch gate |
| `EVENT_LINKER_TOPIC_TOP1_MUST_MATCH` | `1` | Require top-1 topic match |
| `EVENT_LINKER_TITLE_GATE_ENABLED` | `1` | Title contradiction gate |
| `EVENT_LINKER_TITLE_KEYWORD_JACCARD_MIN` | `0.06` | Title keyword threshold |
| `EVENT_LINKER_TITLE_ENTITY_JACCARD_MIN` | `0.01` | Title entity threshold |

### Two-step signals

| Variable | Default | Description |
|---|---|---|
| `EVENT_LINKER_TWO_STEP_ENABLED` | `1` | Require multiple strong signals for auto-link |
| `EVENT_LINKER_AUTO_REQUIRES_SIGNALS` | `2` | Min strong signals |
| `EVENT_LINKER_SIGNAL_MIN_EMBED` | `0.45` | Embedding cosine threshold |
| `EVENT_LINKER_SIGNAL_MIN_ENTITY` | `0.08` | Entity Jaccard threshold |
| `EVENT_LINKER_SIGNAL_MIN_TOPIC` | `0.25` | Topic similarity threshold |

### Split detector

| Variable | Default | Description |
|---|---|---|
| `EVENT_LINKER_SPLIT_DETECTOR_ENABLED` | `1` | Post-merge K=2 split detection |
| `EVENT_LINKER_SPLIT_MIN_ARTICLES` | `4` | Min articles before checking |
| `EVENT_LINKER_SPLIT_CHECK_COOLDOWN_MIN` | `10` | Minutes between checks |
| `EVENT_LINKER_SPLIT_MIN_SEPARATION` | `0.18` | Min centroid cosine distance |
| `EVENT_LINKER_SPLIT_MAX_WITHIN_COHESION` | `0.22` | Min avg distance to centroid |

### Coherence gate

| Variable | Default | Description |
|---|---|---|
| `COHERENCE_GATE_ENABLED` | `1` | Block incoherent events from AI overview |
| `COHERENCE_EMBEDDING_COHESION_THRESHOLD` | `0.60` | Avg pairwise cosine threshold |
| `COHERENCE_ENTITY_OVERLAP_THRESHOLD` | `0.06` | Entity Jaccard threshold |
| `COHERENCE_TITLE_ALIGNMENT_THRESHOLD` | `0.10` | Headline-content Jaccard |
| `COHERENCE_TOPIC_DRIFT_THRESHOLD` | `0.09` | Topic drift stddev max |
| `COHERENCE_MIN_FAILED_CHECKS` | `2` | Checks that must fail to block |

### Publish gate

| Variable | Default | Description |
|---|---|---|
| `PUBLISH_GATE_ENABLED` | `1` | Feed eligibility filter |
| `GATE_MULTI_SOURCES` | `2` | Min sources for multi-source gate |
| `GATE_MULTI_TEXT` | `1200` | Min text for multi-source |
| `GATE_SINGLE_TEXT` | `800` | Min text for single-source |
| `GATE_KEY_FACTS_MIN` | `0` | Min key facts (0 = disabled) |

### Text sanitizer

| Variable | Default | Description |
|---|---|---|
| `TEXT_SANITIZER_ENABLED` | `1` | Text-level sanitization |
| `DEBUG_TEXT_SANITIZER` | `0` | Verbose sanitizer logs |
| `TEXT_SANITIZER_DEDUP_ENABLED` | `1` | Near-duplicate sentence removal |
| `TEXT_SANITIZER_DEDUP_JACCARD` | `0.85` | Shingle dedup threshold |

### Quality metrics

| Variable | Default | Description |
|---|---|---|
| `QUALITY_BOILERPLATE_ENABLED` | `1` | Detect boilerplate in overviews |
| `QUALITY_MIXED_EVENT_ENABLED` | `1` | Detect false merges |
| `QUALITY_MIXED_EVENT_MAX_COHESION` | `0.3` | Pairwise sim threshold |
| `QUALITY_SPLIT_PROXY_ENABLED` | `1` | Detect split candidates |

### LLM (optional)

| Variable | Default | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | (none) | Anthropic API key (optional; heuristic fallback if unset) |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API base URL |
| `LLM_MODEL` | `claude-sonnet-4-5-20250929` | Claude model identifier |
| `LLM_MAX_TOKENS` | `4096` | Max response tokens |
| `LLM_TIMEOUT_MS` | `60000` | Request timeout |

### Development

| Variable | Default | Description |
|---|---|---|
| `DEV_SEED_EVENTS` | (unset) | Set to `1` to auto-seed demo events on startup |
| `BIAS_MIN_CONFIDENCE` | `0.4` | Min confidence for bias display |
| `BIAS_MIN_EVIDENCE_REFS` | `1` | Min evidence refs for bias display |

## API endpoints

### Public

| Method | Path | Description |
|---|---|---|
| GET | `/v1/health` | Health check |
| GET | `/v1/tabs` | Available feed tabs |
| GET | `/v1/feed?tab=global&cursor=<base64>` | Paginated event feed |
| GET | `/v1/events/:eventId` | Event detail (articles, claims, bias, topics) |
| GET | `/v1/events/:eventId/bias/:mediaKey` | Bias labels for event + media |
| GET | `/v1/metrics` | Prometheus metrics (text/plain or JSON) |

### Debug / operations

| Method | Path | Description |
|---|---|---|
| POST | `/v1/debug/scrape/run` | Trigger scrape (async, returns 202 + job_id) |
| GET | `/v1/debug/scrape/status?job_id=<id>` | Scrape job status |
| GET | `/v1/debug/scheduler/status` | Scheduler queue and timing |
| POST | `/v1/debug/scheduler/tick` | Force scheduler tick (dev only) |
| POST | `/v1/debug/lifecycle/tick` | Force lifecycle publish (dev only) |
| POST | `/v1/debug/ai/run?event_id=<uuid>&force=1` | Manual LLM claim + overview run |
| GET | `/v1/debug/feed/stats` | Feed gate filtering analysis |
| GET | `/v1/debug/linker/diagnostics?event_id=<uuid>&limit=20` | Linking decisions + gate stats |
| GET | `/v1/debug/media/status` | Media eligibility + scraper availability |
| GET | `/v1/debug/pipeline/why-empty` | Diagnose empty feed with hints |
| GET | `/v1/debug/quality/snapshot?hours=24` | Quality metrics (boilerplate, mixed, split) |
| GET | `/v1/debug/routing/summary?limit=500` | Content routing decision breakdown |
| GET | `/v1/debug/coherence/summary?limit=200` | Canary report: bins, percentiles, warnings, legacy count |
| GET | `/v1/debug/coherence/sample?limit=50&status=FAIL` | Sample events by coherence status |
| GET | `/v1/debug/extractor/sample?limit=20` | Text extraction diagnostics |

### Example curls

```bash
# Health
curl http://localhost:3000/v1/health

# Feed (first page)
curl http://localhost:3000/v1/feed?tab=global

# Event detail
curl http://localhost:3000/v1/events/<event-id>

# Trigger scrape
curl -X POST http://localhost:3000/v1/debug/scrape/run

# Check scrape status
curl http://localhost:3000/v1/debug/scrape/status

# Why is my feed empty?
curl http://localhost:3000/v1/debug/pipeline/why-empty

# Feed gate diagnostics
curl http://localhost:3000/v1/debug/feed/stats

# Linker decisions for an event
curl "http://localhost:3000/v1/debug/linker/diagnostics?event_id=<uuid>"

# Coherence gate results
curl http://localhost:3000/v1/debug/coherence/summary
curl "http://localhost:3000/v1/debug/coherence/sample?status=FAIL&limit=10"

# Content routing breakdown
curl http://localhost:3000/v1/debug/routing/summary

# Text extractor diagnostics
curl http://localhost:3000/v1/debug/extractor/sample

# Quality snapshot (last 24h)
curl http://localhost:3000/v1/debug/quality/snapshot

# Media status
curl http://localhost:3000/v1/debug/media/status

# Scheduler status
curl http://localhost:3000/v1/debug/scheduler/status

# Force LLM run on an event
curl -X POST "http://localhost:3000/v1/debug/ai/run?event_id=<uuid>&force=1"
```

## Testing

```bash
# Unit + contract tests (no DB required, 775 tests)
npm test

# Watch mode
npm run test:watch

# DB integration tests (requires Postgres on :5433)
DATABASE_URL=postgresql://fundacion:fundacion@localhost:5433/fundacion_test npm test
```

Tests use Vitest. DB integration tests (`src/db/db.test.ts`) are skipped unless
a valid `DATABASE_URL` pointing to a test database is set.

## Troubleshooting

| Problem | Fix |
|---|---|
| `port_in_use` on :3000 | `lsof -ti:3000 \| xargs kill -9` or `PORT=3001 npm run dev` |
| DB unreachable (P1001) | Start Postgres: `docker compose up -d` or `brew services start postgresql@16` |
| DB not found (P1003) | `createdb fundacion` |
| Access denied (P1010) | Check `DATABASE_URL` user matches `SELECT current_user` in psql |
| Feed always empty | 1) Trigger scrape: `curl -X POST .../v1/debug/scrape/run` 2) Wait 5 min (or use `npm run dev:api` for 30 s delay) 3) Check: `curl .../v1/debug/pipeline/why-empty` |
| `URL must start with postgresql://` | Remove quotes from DATABASE_URL in `.env` |
| No media configured | `npm run db:seed` (or `npm run db:seed:minimal`) |
| LLM unavailable | Set `ANTHROPIC_API_KEY` in `.env` (optional; heuristic fallback works without it) |
| Coherence gate blocking events | Check `curl .../v1/debug/coherence/sample?status=FAIL` — lower thresholds or set `COHERENCE_GATE_ENABLED=0` |
| Scrape timeout | Increase `SCRAPE_MEDIA_TIMEOUT_MS` (default 25000) |

## Database schema

10 models: `Media`, `Article`, `Event`, `EventArticle`, `EventVersion`,
`Claim`, `Quote`, `BiasLabel`, `TopicAssignment`, `MediaProfile` + `AuditLog`.

See `src/db/prisma/schema.prisma` for the full schema.

**Event lifecycle states:** `DETECTED` -> `PENDING_PUBLISH` -> `PUBLISHED` -> `CLOSED`
(+ `UPDATING`, `DORMANT` for intermediate/manual states).

**Article statuses:** `DISCOVERED` -> `NORMALIZED` -> `POLICY_OK` | `POLICY_BLOCKED`.

**Coherence gate status** (per EventVersion): `PASS` | `FAIL` | `NA`.
