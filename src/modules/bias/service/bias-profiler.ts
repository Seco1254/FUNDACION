import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { BiasLabelRepository } from '../repo/bias-label-repo.js';
import { MediaProfileRepository } from '../repo/media-profile-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import {
  extractFeatures,
  classifyPrimary,
  classifySecondary,
  computeIntensity,
  buildRationale,
} from './feature-extractor.js';
import { logger } from '../../../core/logging/logger.js';

const PROFILE_WEIGHT_HISTORY = 0.7;
const PROFILE_WEIGHT_CURRENT = 0.3;

export class BiasProfiler {
  constructor(
    private eventRepo: EventRepository,
    private claimRepo: ClaimRepository,
    private biasRepo: BiasLabelRepository,
    private mediaProfileRepo: MediaProfileRepository,
    private mediaRepo: MediaRepository,
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
      const existing = await this.biasRepo.countByVersion(event_id, version_id);
      if (existing > 0) {
        logger.info({ event_id, version_id }, 'bias_labels_already_exist');
        return;
      }

      const articles = await this.eventRepo.findArticlesForEvent(event_id);
      if (articles.length === 0) {
        logger.info({ event_id }, 'no_articles_for_bias');
        return;
      }

      // Get claims/quotes for evidence refs
      const claimsWithQuotes = await this.claimRepo.findClaimsWithQuotesByVersion(event_id, version_id);

      // Build quotes map by article for evidence references
      const quotesByArticle = new Map<string, any[]>();
      for (const claim of claimsWithQuotes) {
        for (const quote of (claim as any).quotes ?? []) {
          const list = quotesByArticle.get(quote.articleId) ?? [];
          list.push({
            quote_id: quote.id,
            text: quote.quoteText,
            url: quote.article?.url ?? '',
            claim_id: claim.id,
          });
          quotesByArticle.set(quote.articleId, list);
        }
      }

      // Article-level bias
      const mediaAccumulators = new Map<string, { features: any; count: number; mediaKey: string }>();

      for (const article of articles) {
        const text = `${article.title}. ${article.snippet}`;
        const features = extractFeatures(text);
        const primary = classifyPrimary(features);
        const secondary = classifySecondary(features);
        const intensity = computeIntensity(features);

        const articleQuotes = quotesByArticle.get(article.id) ?? [];
        const evidenceRefs: { type: 'quote' | 'claim' | 'article'; id: string }[] = [
          { type: 'article', id: article.id },
          ...articleQuotes.slice(0, 3).map((q: any) => ({ type: 'quote' as const, id: q.quote_id })),
        ];

        const rationale = buildRationale(
          features,
          primary.label,
          articleQuotes.slice(0, 2).map((q: any) => ({
            quote_id: q.quote_id,
            text: q.text,
            url: q.url,
          })),
          evidenceRefs,
        );

        await this.biasRepo.create({
          scope: 'ARTICLE_LEVEL',
          articleId: article.id,
          mediaId: article.mediaId,
          eventId: event_id,
          versionId: version_id,
          labelPrimary: primary.label,
          labelSecondary: secondary.label,
          intensity,
          confidence: primary.confidence,
          rationaleJson: rationale,
        });

        // Accumulate for media-level
        const mediaId = article.mediaId;
        const acc = mediaAccumulators.get(mediaId) ?? { features: {}, count: 0, mediaKey: '' };
        if (acc.count === 0) {
          const media = await this.mediaRepo.findById(mediaId);
          acc.mediaKey = media?.mediaKey ?? 'unknown';
          acc.features = { emotional: 0, critical: 0, negation: 0, institutional: 0, technical: 0, attribution: 0, pro_gov: 0, anti_gov: 0 };
        }
        for (const [k, v] of Object.entries(features)) {
          acc.features[k] = (acc.features[k] ?? 0) + (v as number);
        }
        acc.count++;
        mediaAccumulators.set(mediaId, acc);
      }

      // Media-level bias (blend profile + current)
      for (const [mediaId, acc] of mediaAccumulators.entries()) {
        // Average features for this event's articles
        const avgFeatures: any = {};
        for (const k of Object.keys(acc.features)) {
          avgFeatures[k] = acc.features[k] / acc.count;
        }

        // Get historical profile
        const profile = await this.mediaProfileRepo.findByMediaId(mediaId);
        const histFeatures = (profile?.profileJson as any)?.avg_features ?? null;

        // Blend: 70% history, 30% current (or 100% current if no history)
        const blendedFeatures: any = {};
        if (histFeatures) {
          for (const k of Object.keys(avgFeatures)) {
            blendedFeatures[k] = PROFILE_WEIGHT_HISTORY * (histFeatures[k] ?? 0) + PROFILE_WEIGHT_CURRENT * avgFeatures[k];
          }
        } else {
          Object.assign(blendedFeatures, avgFeatures);
        }

        const primary = classifyPrimary(blendedFeatures);
        const secondary = classifySecondary(blendedFeatures);
        const intensity = computeIntensity(blendedFeatures);

        // Collect top quotes across all articles of this media
        const mediaQuotes: any[] = [];
        for (const article of articles) {
          if (article.mediaId === mediaId) {
            const qs = quotesByArticle.get(article.id) ?? [];
            mediaQuotes.push(...qs);
          }
        }

        const evidenceRefs = mediaQuotes.slice(0, 3).map((q: any) => ({
          type: 'quote' as const,
          id: q.quote_id,
        }));

        const rationale = buildRationale(
          blendedFeatures,
          primary.label,
          mediaQuotes.slice(0, 2).map((q: any) => ({
            quote_id: q.quote_id,
            text: q.text,
            url: q.url,
          })),
          evidenceRefs,
        );

        await this.biasRepo.create({
          scope: 'MEDIA_LEVEL',
          mediaId,
          eventId: event_id,
          versionId: version_id,
          labelPrimary: primary.label,
          labelSecondary: secondary.label,
          intensity,
          confidence: primary.confidence,
          rationaleJson: rationale,
        });

        // Update media profile incrementally
        const updatedProfile = {
          avg_features: blendedFeatures,
          last_label: primary.label,
          articles_processed: ((profile?.profileJson as any)?.articles_processed ?? 0) + acc.count,
        };
        await this.mediaProfileRepo.upsert(mediaId, updatedProfile);
      }

      await this.auditWriter.write({
        entity_type: 'BIAS',
        entity_id: event_id,
        action: 'BIAS_LABELS_BUILT',
        trace_id: traceId,
        data: { version_id, article_count: articles.length, media_count: mediaAccumulators.size },
      });

      await this.eventBus.publish({
        event_name: 'BiasLabelsBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'bias' },
        payload: { event_id, version_id },
      });
    };
  }
}
