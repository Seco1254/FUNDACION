# Quality Loop — Event Labels

Manual quality labeling system for auditing events in the feed.

## Labels

| Label | Meaning |
|-------|---------|
| `GOOD` | Correct event — no issues |
| `BAD_MERGE` | Articles from different events were merged incorrectly |
| `BAD_SOURCE` | Bad or unreliable source(s) |
| `BAD_TOPIC` | Wrong topic classification |
| `BAD_IMPORTANCE` | Importance score is wrong (too high/low) |
| `BAD_ADS_COMMERCIAL` | Commercial/advertising content leaked into feed |
| `BAD_OTHER` | Other issue (requires `--note`) |

## CLI Usage

### Label an event

```bash
# Mark as good
npm run debug:events:label -- label --event_id=<uuid> --label=GOOD

# Mark as bad merge with a note
npm run debug:events:label -- label --event_id=<uuid> --label=BAD_MERGE --note="mezclado con evento X"

# BAD_OTHER requires a note
npm run debug:events:label -- label --event_id=<uuid> --label=BAD_OTHER --note="contenido duplicado"

# Skip snapshot (faster)
npm run debug:events:label -- label --event_id=<uuid> --label=GOOD --snapshot=0
```

### Remove labels

```bash
# Remove most recent label for an event
npm run debug:events:label -- unlabel --event_id=<uuid>

# Remove ALL labels for an event
npm run debug:events:label -- unlabel --event_id=<uuid> --all=1
```

### List recent labels

```bash
# Last 50 labels from last 7 days (defaults)
npm run debug:events:label -- list

# Filter by label type
npm run debug:events:label -- list --label=BAD_MERGE

# More results, longer window
npm run debug:events:label -- list --limit=100 --sinceHours=720

# Pretty table output
npm run debug:events:label -- list --format=table
```

### Stats

```bash
# Counts per label + top BAD_OTHER notes
npm run debug:events:label -- stats

# Pretty table
npm run debug:events:label -- stats --format=table
```

## API

### GET /v1/debug/labels

Query params: `sinceHours` (default 168), `limit` (default 50), `label` (optional filter).

```bash
curl 'http://localhost:3000/v1/debug/labels?limit=10&label=BAD_MERGE'
```

### POST /v1/debug/labels

```bash
curl -X POST http://localhost:3000/v1/debug/labels \
  -H 'Content-Type: application/json' \
  -d '{"event_id":"<uuid>","label":"GOOD"}'
```

## Snapshot

When `--snapshot=1` (default), the label stores a frozen copy of the event's features at labeling time. Fields stored in `snapshot_json`:

| Key | Source |
|-----|--------|
| `title` | EventVersion.headline |
| `status` | Event.state |
| `publishAt` | Event.publish_at |
| `updatedAt` | Event.t_last |
| `coverage` | num_articles, num_sources_unique, sources list |
| `coherence_gate` | status + metrics from packet_json |
| `quality_flags` | split_proxy + detail |
| `ranking_features` | from packet_json |
| `topic_key` | aggregateEventTopic() result |
| `topic_confidence` | aggregateEventTopic() result |
| `topic_signals` | aggregateEventTopic() result |
| `topic_reason` | aggregateEventTopic() result |
| `importance_score` | computeImportanceScore() |
| `demotion_multiplier` | computeDemotionMultiplier() |
| `demotion_reasons` | computeDemotionMultiplier() |
| `representative_article` | url, mediaKey, text_len, page_type, desk, desk_source |
| `eligibility` | feed_eligible + reasons |

If a field doesn't exist in the DB, it's stored as `null`.

## Database

Table: `event_label` (Prisma model: `EventLabel`)

```
id            UUID PK
event_id      UUID (indexed)
label         TEXT (indexed)
note          TEXT nullable
git_sha       TEXT nullable
snapshot_json JSONB
created_at    TIMESTAMP (indexed DESC)
```

Migration: `20260303120000_add_event_label`
