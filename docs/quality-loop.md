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

---

## Full Workflow: Session → Label → Export

### Step 1: Start a labeling session

List recent PUBLISHED events ready for review:

```bash
# Last 6 hours, top 20 events (defaults)
npm run debug:labels:session

# Last 24 hours, table format
npm run debug:labels:session -- --hours=24 --limit=30

# NDJSON output for scripting
npm run debug:labels:session -- --format=ndjson --hours=12
```

Example table output:
```
──────────────────────────────────────────────────────────────────────────
event_id    title                                                             topic              conf  arts  srcs  rep_url
──────────────────────────────────────────────────────────────────────────
a1b2c3d4…   Gobierno anuncia reforma tributaria para 2026                      POLITICA           0.85     5     3  https://eltiempo.com/politica/reforma-123
e5f6g7h8…   Atlético Nacional venció a Millonarios en la liga                  DEPORTES           0.72     3     2  https://eltiempo.com/deportes/nacional-456
──────────────────────────────────────────────────────────────────────────
2 events
```

### Step 2: Label events

Copy event IDs from the session and label them:

```bash
npm run debug:events:label -- label --event_id=a1b2c3d4-... --label=GOOD
npm run debug:events:label -- label --event_id=e5f6g7h8-... --label=BAD_TOPIC --note="debería ser POLITICA, no DEPORTES"
```

### Step 3: Export labeled dataset

```bash
# NDJSON (default) — latest label per event, PUBLISHED only
npm run debug:labels:export

# CSV for spreadsheet analysis
npm run debug:labels:export -- --format=csv

# All labels (not just latest), include article samples
npm run debug:labels:export -- --latestOnly=0 --includeArticles=1

# Only BAD labels, any event state
npm run debug:labels:export -- --label=BAD_TOPIC --publishedOnly=0

# Last 30 days
npm run debug:labels:export -- --sinceHours=720 --format=csv
```

Example NDJSON output (2 lines):
```json
{"event_id":"a1b2c3d4-...","label":"GOOD","note":null,"label_created_at":"2026-03-03T12:00:00.000Z","title":"Gobierno anuncia reforma","publishAt":"2026-03-03T10:00:00.000Z","num_articles":5,"num_sources_unique":3,"sources":"eltiempo:3|semana:1|razon_publica:1","topic_key":"POLITICA","topic_confidence":0.85,"topic_reason":"DESK_BOOST+CO_KW","topic_signals":"DESK_BOOST:POLITICA|CO_KW:gobierno","importance_score":0.72,"demotion_multiplier":1,"demotion_reasons":"","coherence_status":"PASS","cohesion":0.82,"entity_overlap":0.45,"title_alignment":0.3,"topic_drift":0.05,"split_proxy":false,"split_proxy_reasons":"","rep_url":"https://eltiempo.com/politica/reforma-123","rep_mediaKey":"eltiempo","rep_text_len":2500,"rep_page_type":"news","rep_desk":"POLITICA","rep_desk_source":"url_segment","rep_blocked_reason":null,"eligibility_feed_eligible":true,"eligibility_reasons":""}
{"event_id":"e5f6g7h8-...","label":"BAD_TOPIC","note":"debería ser POLITICA","label_created_at":"2026-03-03T12:05:00.000Z","title":"Nacional gana clásico","publishAt":"2026-03-03T09:00:00.000Z","num_articles":3,"num_sources_unique":2,"sources":"eltiempo:2|semana:1","topic_key":"DEPORTES","topic_confidence":0.72,"topic_reason":"CO_KW","topic_signals":"CO_KW:atlético nacional","importance_score":0.55,"demotion_multiplier":0.8,"demotion_reasons":"SINGLE_SOURCE","coherence_status":"PASS","cohesion":0.78,"entity_overlap":0.5,"title_alignment":0.4,"topic_drift":0.03,"split_proxy":false,"split_proxy_reasons":"","rep_url":"https://eltiempo.com/deportes/nacional-456","rep_mediaKey":"eltiempo","rep_text_len":1800,"rep_page_type":"news","rep_desk":"DEPORTES","rep_desk_source":"url_segment","rep_blocked_reason":null,"eligibility_feed_eligible":true,"eligibility_reasons":""}
```

Example CSV header:
```
event_id,label,note,label_created_at,title,publishAt,num_articles,num_sources_unique,sources,topic_key,topic_confidence,topic_reason,topic_signals,importance_score,demotion_multiplier,demotion_reasons,coherence_status,cohesion,entity_overlap,title_alignment,topic_drift,split_proxy,split_proxy_reasons,rep_url,rep_mediaKey,rep_text_len,rep_page_type,rep_desk,rep_desk_source,rep_blocked_reason,eligibility_feed_eligible,eligibility_reasons
```

## Export CLI Reference

### `npm run debug:labels:export`

| Flag | Default | Description |
|------|---------|-------------|
| `--sinceHours` | 168 | Time window (0 = all-time) |
| `--limit` | 5000 | Max labels to fetch |
| `--format` | ndjson | `ndjson` or `csv` |
| `--latestOnly` | 1 | Only latest label per event |
| `--includeArticles` | 0 | Add `articles_sample` column (cap 5) |
| `--label` | (all) | Filter by label value |
| `--publishedOnly` | 1 | Only PUBLISHED events |

### `npm run debug:labels:session`

| Flag | Default | Description |
|------|---------|-------------|
| `--hours` | 6 | Time window for publishAt |
| `--limit` | 20 | Max events to show |
| `--publishedOnly` | 1 | Only PUBLISHED events |
| `--format` | table | `table` or `ndjson` |
