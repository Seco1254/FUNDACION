import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { TopicAssignmentRepository } from '../repo/topic-assignment-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { logger } from '../../../core/logging/logger.js';
import type { TopicScore, HeatmapBin } from '../domain/types.js';
import topicsList from '../../../constants/topics_v0_1.json' with { type: 'json' };
import topicsKeywords from '../../../constants/topics_keywords_v0_1.json' with { type: 'json' };

const TOPICS: string[] = topicsList;
const KEYWORDS: Record<string, string[]> = topicsKeywords;
const MIN_WEIGHT = 0.20;
const MAX_EMERGENT = 3;
const EMERGENT_MIN_ARTICLES = 3;
const BIN_HOURS = 6;
const MAX_BINS = 28; // 7 days

export function scoreTopicsForText(text: string): TopicScore[] {
  const lower = text.toLowerCase();
  const tokens = lower.split(/\s+/);
  const totalTokens = tokens.length || 1;

  const scores: TopicScore[] = [];
  for (const topic of TOPICS) {
    if (topic === 'OTROS') continue;
    const keywords = KEYWORDS[topic] ?? [];
    let matchCount = 0;
    for (const kw of keywords) {
      for (const token of tokens) {
        if (token.includes(kw)) matchCount++;
      }
    }
    const weight = matchCount / totalTokens;
    if (weight > 0) {
      scores.push({ topic_key: topic, weight });
    }
  }

  // Sort by weight desc, take top 2 if >= MIN_WEIGHT
  scores.sort((a, b) => b.weight - a.weight);
  const topScores = scores.filter((s) => s.weight >= MIN_WEIGHT).slice(0, 2);

  if (topScores.length === 0) {
    return [{ topic_key: 'OTROS', weight: 1.0 }];
  }

  return topScores;
}

export function detectEmergentTopics(
  claimTexts: string[],
  articleCount: number,
): string[] {
  if (articleCount < EMERGENT_MIN_ARTICLES) return [];

  // Extract 2-grams from all claim texts
  const ngramCounts = new Map<string, number>();
  for (const text of claimTexts) {
    const tokens = text.toLowerCase().split(/\s+/).filter((t) => t.length > 3);
    for (let i = 0; i < tokens.length - 1; i++) {
      const ngram = `${tokens[i]} ${tokens[i + 1]}`;
      ngramCounts.set(ngram, (ngramCounts.get(ngram) ?? 0) + 1);
    }
  }

  // Filter: appears in >=3 articles-worth of claims, and not in any closed topic keywords
  const allClosedKeywords = new Set<string>();
  for (const kws of Object.values(KEYWORDS)) {
    for (const kw of kws) allClosedKeywords.add(kw);
  }

  const emergent: string[] = [];
  const sorted = Array.from(ngramCounts.entries()).sort((a, b) => b[1] - a[1]);

  for (const [ngram, count] of sorted) {
    if (count < EMERGENT_MIN_ARTICLES) break;
    const ngramTokens = ngram.split(' ');
    const mapsToClosedTopic = ngramTokens.some((t) => allClosedKeywords.has(t));
    if (!mapsToClosedTopic) {
      const slug = ngram.replace(/\s+/g, '_').toUpperCase().slice(0, 30);
      emergent.push(`EMERG_${slug}`);
      if (emergent.length >= MAX_EMERGENT) break;
    }
  }

  return emergent;
}

export function buildHeatmap(
  articles: { publishedAt: Date | null; topicScores: TopicScore[] }[],
  t0: Date,
): HeatmapBin[] {
  const bins: HeatmapBin[] = [];
  const binMs = BIN_HOURS * 60 * 60 * 1000;

  for (let i = 0; i < MAX_BINS; i++) {
    const binStart = new Date(t0.getTime() + i * binMs);
    const binEnd = new Date(binStart.getTime() + binMs);
    bins.push({
      bin_index: i,
      bin_start: binStart.toISOString(),
      bin_end: binEnd.toISOString(),
      topics: {},
    });
  }

  for (const article of articles) {
    if (!article.publishedAt) continue;
    const offset = article.publishedAt.getTime() - t0.getTime();
    if (offset < 0) continue;
    const binIdx = Math.floor(offset / binMs);
    if (binIdx >= MAX_BINS) continue;

    for (const ts of article.topicScores) {
      bins[binIdx].topics[ts.topic_key] = (bins[binIdx].topics[ts.topic_key] ?? 0) + ts.weight;
    }
  }

  // Normalize per-bin
  for (const bin of bins) {
    const total = Object.values(bin.topics).reduce((s, v) => s + v, 0);
    if (total > 0) {
      for (const key of Object.keys(bin.topics)) {
        bin.topics[key] = Math.round((bin.topics[key] / total) * 1000) / 1000;
      }
    }
  }

  return bins;
}

export class TopicAssigner {
  constructor(
    private eventRepo: EventRepository,
    private claimRepo: ClaimRepository,
    private topicRepo: TopicAssignmentRepository,
    private versionRepo: VersionRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
  ) {}

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, version_id } = envelope.payload as {
        event_id: string;
        version_id: string;
      };
      const traceId = envelope.trace.trace_id;

      // Idempotency
      const existing = await this.topicRepo.countByVersion(event_id, version_id);
      if (existing > 0) {
        logger.info({ event_id, version_id }, 'topics_already_assigned');
        return;
      }

      const articles = await this.eventRepo.findArticlesForEvent(event_id);
      if (articles.length === 0) {
        logger.info({ event_id }, 'no_articles_for_topics');
        return;
      }

      const event = await this.eventRepo.findById(event_id);
      const t0 = event?.t0 ?? new Date();

      // Get claims for emergent topic detection
      const claims = await this.claimRepo.findClaimsByVersion(event_id, version_id);
      const claimTexts = claims.map((c: any) => c.claimText);

      // Assign topics per article
      const articleTopicData: { publishedAt: Date | null; topicScores: TopicScore[] }[] = [];

      for (const article of articles) {
        const text = `${article.title}. ${article.snippet}`;
        const scores = scoreTopicsForText(text);

        for (const score of scores) {
          await this.topicRepo.create({
            eventId: event_id,
            versionId: version_id,
            articleId: article.id,
            topicKey: score.topic_key,
            weight: score.weight,
          });
        }

        articleTopicData.push({
          publishedAt: article.publishedAt,
          topicScores: scores,
        });
      }

      // Detect emergent topics
      const emergentTopics = detectEmergentTopics(claimTexts, articles.length);

      // Build heatmap
      const heatmap = buildHeatmap(articleTopicData, t0);

      // Aggregate top topics across all articles
      const topicAgg = new Map<string, number>();
      for (const ad of articleTopicData) {
        for (const ts of ad.topicScores) {
          topicAgg.set(ts.topic_key, (topicAgg.get(ts.topic_key) ?? 0) + ts.weight);
        }
      }
      const topTopics = Array.from(topicAgg.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key, weight]) => ({ topic_key: key, weight: Math.round(weight * 1000) / 1000 }));

      // Update packet_json with topics + heatmap
      const version = await this.versionRepo.findById(version_id);
      if (version) {
        const existingPacket = (version.packetJson as any) ?? {};
        const updatedPacket = {
          ...existingPacket,
          topics: { top_topics: topTopics, emergent: emergentTopics },
          topics_heatmap: heatmap,
        };
        await this.versionRepo.update(version_id, { packetJson: updatedPacket });
      }

      await this.auditWriter.write({
        entity_type: 'TOPIC',
        entity_id: event_id,
        action: 'TOPICS_ASSIGNED',
        trace_id: traceId,
        data: { version_id, article_count: articles.length, emergent_count: emergentTopics.length },
      });

      await this.eventBus.publish({
        event_name: 'TopicHeatmapBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'topics' },
        payload: { event_id, version_id },
      });
    };
  }
}
