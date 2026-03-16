/**
 * Event-bus metric subscribers.
 * Each subscriber listens to a pipeline event and increments/observes metrics.
 */

import { EventEnvelope } from '../event_bus/envelope.js';
import { EventBus } from '../event_bus/dispatcher.js';
import { metrics } from './metrics.js';

export function registerMetricSubscribers(eventBus: EventBus): void {
  // ── Gate FAIL rate ──
  eventBus.subscribe('OverviewGenerated', 'Metrics.gateFail', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    metrics.incCounter('overview.generated.total');
    if (payload.gate_status === 'FAIL') {
      metrics.incCounter('overview.gate_fail.total');
    }
  });

  // ── Merge rate (articles linked to existing events) ──
  eventBus.subscribe('ArticleLinkedToEvent', 'Metrics.merge', async (_env: EventEnvelope) => {
    metrics.incCounter('article.linked.total');
  });

  // ── New events ──
  eventBus.subscribe('EventCreated', 'Metrics.eventCreated', async (_env: EventEnvelope) => {
    metrics.incCounter('event.created.total');
  });

  // ── Claim graph ──
  eventBus.subscribe('ClaimGraphBuilt', 'Metrics.claimGraph', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    metrics.incCounter('claim_graph.built.total');
    if (typeof payload.disputed_count === 'number' && payload.disputed_count > 0) {
      metrics.incCounter('claim.disputed.total', payload.disputed_count as number);
    }
  });

  // ── Bias labels ──
  eventBus.subscribe('BiasLabelsBuilt', 'Metrics.biasLabels', async (_env: EventEnvelope) => {
    metrics.incCounter('bias.labels_built.total');
  });

  // ── Topics + heatmap ──
  eventBus.subscribe('TopicHeatmapBuilt', 'Metrics.topicHeatmap', async (_env: EventEnvelope) => {
    metrics.incCounter('topic.heatmap_built.total');
  });

  // ── SubEvents ──
  eventBus.subscribe('SubEventsBuilt', 'Metrics.subEvents', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    metrics.incCounter('subevent.built.total');
    if (typeof payload.subevent_count === 'number') {
      metrics.incCounter('subevent.detected.total', payload.subevent_count as number);
    }
  });

  // ── Scraping health ──
  eventBus.subscribe('ArticleDiscovered', 'Metrics.articleDiscovered', async (_env: EventEnvelope) => {
    metrics.incCounter('article.discovered.total');
  });

  eventBus.subscribe('ArticleNormalized', 'Metrics.articleNormalized', async (_env: EventEnvelope) => {
    metrics.incCounter('article.normalized.total');
  });

  eventBus.subscribe('ArticlePolicyOk', 'Metrics.articlePolicyOk', async (_env: EventEnvelope) => {
    metrics.incCounter('article.policy_ok.total');
  });

  // ── Policy blocks (per reason + per media) ──
  eventBus.subscribe('ArticlePolicyBlocked', 'Metrics.articlePolicyBlocked', async (env: EventEnvelope) => {
    const payload = env.payload as Record<string, unknown>;
    const reason = typeof payload.reason_code === 'string' ? payload.reason_code : 'UNKNOWN';
    const mediaKey = typeof payload.media_key === 'string' ? payload.media_key : 'unknown';
    metrics.incCounter('article.policy_blocked.total');
    metrics.incCounter(`article.policy_blocked.${reason}.total`);
    metrics.incCounter(`article.policy_blocked.by_media.${mediaKey}.total`);
  });

  // ── Version committed (for drift frequency) ──
  eventBus.subscribe('EventVersionCommitted', 'Metrics.versionCommitted', async (_env: EventEnvelope) => {
    metrics.incCounter('version.committed.total');
  });

  // ── Embedding funnel ──
  eventBus.subscribe('ArticleEmbedded', 'Metrics.articleEmbedded', async (_env: EventEnvelope) => {
    metrics.incCounter('article.embedded.total');
  });

  // ── Published events ──
  eventBus.subscribe('EventPublished', 'Metrics.eventPublished', async (_env: EventEnvelope) => {
    metrics.incCounter('event.published.total');
  });
}
