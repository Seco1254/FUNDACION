# Runbook: Article Text + AI Overview Audit

## 1. Check article text extraction

### Top 20 articles by text length (ascending - shortest first)
```sql
SELECT a.url, m.media_key, a.status, a.blocked_reason,
       length(a.text_norm) as text_len, length(a.snippet) as snippet_len,
       a.created_at
FROM article a
JOIN media m ON a.media_id = m.id
WHERE a.status = 'POLICY_OK'
ORDER BY length(COALESCE(a.text_norm, '')) ASC
LIMIT 20;
```

### Top 20 articles by text length (descending - longest first)
```sql
SELECT a.url, m.media_key, length(a.text_norm) as text_len, a.created_at
FROM article a
JOIN media m ON a.media_id = m.id
WHERE a.status = 'POLICY_OK'
ORDER BY length(COALESCE(a.text_norm, '')) DESC
LIMIT 20;
```

### Count articles by text_len buckets
```sql
SELECT
  COUNT(*) FILTER (WHERE COALESCE(length(a.text_norm), 0) = 0)   AS "no_text",
  COUNT(*) FILTER (WHERE length(a.text_norm) BETWEEN 1 AND 299)  AS "under_300",
  COUNT(*) FILTER (WHERE length(a.text_norm) BETWEEN 300 AND 799) AS "300_to_799",
  COUNT(*) FILTER (WHERE length(a.text_norm) >= 800)              AS "800_plus",
  COUNT(*) as total
FROM article a
WHERE a.status = 'POLICY_OK';
```

## 2. Check overview quality in feed

### Feed overview check (no "Sin informacion disponible")
```bash
curl -s http://localhost:3000/v1/feed | jq '
  .items[] |
  { event_id, overview_status,
    wh_count: (.ai_overview.what_happened // [] | length),
    ctx_count: (.ai_overview.context // [] | length),
    confidence: .ai_overview.confidence_label
  }
'
```

### Check for empty overviews in feed
```bash
curl -s http://localhost:3000/v1/feed | jq '
  [.items[] | select(.ai_overview == null or (.ai_overview.what_happened | length) == 0)] | length
'
# Should be 0 for events with article text >= 800
```

## 3. Debug a specific event's AI pipeline

### Full diagnostic
```bash
# Replace EVENT_ID with actual event ID
curl -s -X POST "http://localhost:3000/v1/debug/ai/run?event_id=EVENT_ID&force=1" | jq '{
  overview_mode,
  gate_status,
  confidence_label,
  article_count,
  unique_media_count,
  supported_claims_count,
  sections_filled_count,
  facts_extracted_count,
  per_article: [.per_article[] | {url, media_key, text_len, status}]
}'
```

### Check overview_mode distribution
```sql
SELECT
  (packet_json->>'overview_mode') as mode,
  COUNT(*) as count
FROM event_version
WHERE packet_json->>'overview_mode' IS NOT NULL
GROUP BY 1
ORDER BY 2 DESC;
```

## 4. Validate text extraction quality

### Sample articles with text
```sql
SELECT a.url, m.media_key,
       length(a.text_norm) as text_len,
       left(a.text_norm, 200) as text_preview
FROM article a
JOIN media m ON a.media_id = m.id
WHERE a.status = 'POLICY_OK' AND length(a.text_norm) >= 800
ORDER BY a.created_at DESC
LIMIT 5;
```

### Check for boilerplate leakage
```sql
SELECT a.url, m.media_key
FROM article a
JOIN media m ON a.media_id = m.id
WHERE a.status = 'POLICY_OK'
  AND (a.text_norm ILIKE '%suscríbete%'
    OR a.text_norm ILIKE '%newsletter%'
    OR a.text_norm ILIKE '%inicia sesión%'
    OR a.text_norm ILIKE '%cookies%');
# Should return 0 rows
```

## 5. End-to-end validation flow

```bash
# 1. Reset and re-scrape
npm run reset:db && npm run dev:api &
sleep 5
curl -s -X POST http://localhost:3000/v1/debug/scrape/run | jq .

# 2. Wait for publish cycle (~5 min)
sleep 310

# 3. Check feed
curl -s http://localhost:3000/v1/feed | jq '.items | length'

# 4. Verify no empty overviews
curl -s http://localhost:3000/v1/feed | jq '
  [.items[] | select(.overview_status != "ready")] | length
'

# 5. Spot-check 3 events
curl -s http://localhost:3000/v1/feed | jq -r '.items[:3][].event_id' | while read eid; do
  echo "=== Event: $eid ==="
  curl -s "http://localhost:3000/v1/event/$eid" | jq '{
    overview_status,
    wh: (.ai_overview.what_happened // [])[:2],
    ctx: (.ai_overview.context // [])[:2],
    confidence: .ai_overview.confidence_label
  }'
done
```
