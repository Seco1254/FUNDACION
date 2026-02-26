-- CreateView: coherence_gate_metrics
-- Extracts coherence gate metrics from event_version.packet_json for observability.
-- Only includes rows where packet_json contains a 'coherence_gate' key.

CREATE OR REPLACE VIEW coherence_gate_metrics AS
SELECT
  ev.event_id,
  ev.created_at,
  ev.headline,
  ev.version_index,
  (ev.packet_json->'coherence_gate'->>'status')                        AS status,
  -- Handle both old 'details' format and correct 'metrics' format
  COALESCE(
    (ev.packet_json->'coherence_gate'->'metrics'->>'avg_cosine')::float,
    (ev.packet_json->'coherence_gate'->'details'->>'embedding_cohesion')::float
  ) AS avg_cosine,
  COALESCE(
    (ev.packet_json->'coherence_gate'->'metrics'->>'entity_jaccard')::float,
    (ev.packet_json->'coherence_gate'->'details'->>'entity_overlap')::float
  ) AS entity_jaccard,
  COALESCE(
    (ev.packet_json->'coherence_gate'->'metrics'->>'title_jaccard')::float,
    (ev.packet_json->'coherence_gate'->'details'->>'title_alignment')::float
  ) AS title_jaccard,
  COALESCE(
    (ev.packet_json->'coherence_gate'->'metrics'->>'stddev_drift')::float,
    (ev.packet_json->'coherence_gate'->'details'->>'topic_drift_variance')::float
  ) AS stddev_drift,
  (ev.packet_json->'coherence_gate'->'metrics'->>'article_count')::int    AS article_count,
  ev.packet_json->'coherence_gate'->'failed_checks'                       AS failed_checks,
  ev.packet_json->'coherence_gate'->'thresholds'                          AS thresholds
FROM event_version ev
WHERE ev.packet_json ? 'coherence_gate';
