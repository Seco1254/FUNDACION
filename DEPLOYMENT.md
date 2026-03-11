# Deployment Guide

## Environment Variables

### Server
| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP listen port |
| `DATABASE_URL` | — | PostgreSQL connection string (required) |
| `REQUEST_TIMEOUT_MS` | `30000` | Server request timeout in ms |

### Cache
| Variable | Default | Description |
|---|---|---|
| `CACHE_MAX_ENTRIES` | `500` | Max in-memory LRU cache entries |
| `CACHE_DEFAULT_TTL_MS` | `30000` | Default cache TTL in ms |

### Rate Limiting
| Variable | Default | Description |
|---|---|---|
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limit sliding window in ms |
| `RATE_LIMIT_MAX` | `60` | Max requests per IP per window |

### Bias Safeguards
| Variable | Default | Description |
|---|---|---|
| `BIAS_MIN_CONFIDENCE` | `0.4` | Minimum confidence to display bias label (below → INCONCLUSO) |
| `BIAS_MIN_EVIDENCE_REFS` | `1` | Minimum evidence refs required (below → INCONCLUSO) |

## Run Commands

### Development
```bash
npm run dev          # tsx watch mode
npm test             # vitest run
npm run test:watch   # vitest watch
```

### Production
```bash
npm run build        # tsc compile
npm run db:migrate   # prisma migrate deploy
npm start            # node dist/server.js
```

### Database
```bash
npm run db:migrate:dev   # prisma migrate dev (creates migration)
npm run db:migrate       # prisma migrate deploy (applies migrations)
npm run db:seed          # seed initial data
npm run db:reset         # DANGER: reset database
npm run db:generate      # regenerate Prisma client
```

## Infrastructure Recommendations

### Minimum Requirements
- **Node.js** 20+ (ES2022 target)
- **PostgreSQL** 15+
- **Memory** 512MB+ (in-memory cache, singleflight, rate-limit stores)

### Production Setup
1. **Reverse proxy**: Nginx or Cloudflare in front for TLS termination and static assets
2. **Process manager**: PM2 or systemd for auto-restart
3. **Database**: Managed PostgreSQL (e.g., Neon, Supabase, RDS)
4. **Monitoring**: `/v1/metrics` endpoint supports JSON and Prometheus text format

### Scaling Notes
- Single-process architecture with in-memory cache — scale vertically first
- Cache and rate-limit stores are per-process; if running multiple instances, consider a shared store (Redis)
- EventBus is in-process; all pipeline handlers run in the same process
- Feed cache TTL is 30s, event detail cache is 60s — tunable via env vars

## Production Checklist

- [ ] `DATABASE_URL` set to production PostgreSQL
- [ ] `npm run db:migrate` executed successfully
- [ ] `npm run db:seed` executed (if first deploy)
- [ ] `RATE_LIMIT_MAX` tuned for expected traffic
- [ ] `BIAS_MIN_CONFIDENCE` reviewed (default 0.4)
- [ ] TLS enabled via reverse proxy
- [ ] Health check configured: `GET /v1/health`
- [ ] Metrics scraping configured: `GET /v1/metrics`
- [ ] Log aggregation configured (stdout JSON via pino)
- [ ] Backup strategy for PostgreSQL in place

## API Endpoints

| Method | Path | Cache TTL | Description |
|---|---|---|---|
| GET | `/v1/health` | none | Health check |
| GET | `/v1/tabs` | none | Tab list |
| GET | `/v1/feed?tab=&cursor=` | 30s | Feed with pagination |
| GET | `/v1/events/:eventId` | 60s | Event detail with bias/topics |
| GET | `/v1/events/:eventId/bias/:mediaKey` | 60s | Bias rationale per media |
| GET | `/v1/metrics` | none | Prometheus/JSON metrics |

## Rate Limiting Headers

All responses include:
- `X-RateLimit-Limit`: requests per window
- `X-RateLimit-Remaining`: remaining requests
- `X-RateLimit-Reset`: window reset epoch (seconds)
- `Retry-After`: seconds until retry (only on 429)

## Caching Headers

Cached endpoints include:
- `ETag`: weak ETag for conditional requests
- `Cache-Control`: public, max-age=N, stale-while-revalidate=M
- `Vary`: Accept, Accept-Encoding

Clients can send `If-None-Match` to receive 304 Not Modified.

## Cache Invalidation

Cache is automatically invalidated via the event bus:
- `EventVersionCommitted` → clears event detail + all feed caches
- `BiasLabelsBuilt` → clears event detail + bias caches
- `SubEventsBuilt` → clears event detail cache

## Troubleshooting

If the UI shows empty or the feed returns no items, see [RUNBOOK_UI_NOT_LOADING.md](./RUNBOOK_UI_NOT_LOADING.md) or run `npm run debug:ui`.
