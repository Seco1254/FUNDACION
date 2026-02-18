import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { MediaRepository } from '../../media/repo/media-repo.js';
import { ClaimRepository } from '../repo/claim-repo.js';
import { logger } from '../../../core/logging/logger.js';
import type { ClaimType, ClaimStatus, QuoteStrength, QuoteRole } from '../domain/types.js';
import type { LlmClient } from '../../../core/llm/client.js';
import { buildClaimExtractionPrompt, CLAIM_EXTRACTION_SYSTEM } from '../../../core/llm/prompts.js';
import type { ArticleInput } from '../../../core/llm/prompts.js';

interface ClaimCandidate {
  claimTextNorm: string;
  claimType: ClaimType;
  quotes: QuoteCandidate[];
}

interface QuoteCandidate {
  articleId: string;
  mediaId: string;
  quoteText: string;
  spanStart: number | null;
  spanEnd: number | null;
  strength: QuoteStrength;
  role: QuoteRole;
}

// Split text into sentences, careful with common abbreviations
const ABBREVIATIONS = /(?:Sr|Sra|Dr|Dra|Ing|Lic|Jr|vs|etc|No|Art|Col|Gen|Pdte)\./gi;

function splitSentences(text: string): string[] {
  // Protect abbreviations by replacing their dots
  let protected_ = text;
  const replacements: string[] = [];
  protected_ = protected_.replace(ABBREVIATIONS, (match) => {
    const idx = replacements.length;
    replacements.push(match);
    return `__ABBR${idx}__`;
  });

  // Split on sentence-ending punctuation
  const parts = protected_.split(/(?<=[.;:])\s+/);

  // Restore abbreviations
  return parts.map((p) => {
    let restored = p;
    for (let i = 0; i < replacements.length; i++) {
      restored = restored.replace(`__ABBR${i}__`, replacements[i]);
    }
    return restored.trim();
  }).filter((s) => s.length > 0);
}

function normalizeClaim(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ');
}

function classifyClaim(text: string): ClaimType {
  const lower = text.toLowerCase();
  if (/\d+%|\d+/.test(text)) return 'QUANT';
  if (/según|afirmó|dijo|declaró|indicó|señaló|aseguró/.test(lower)) return 'ALLEGATION';
  if (/podría|se espera|pronostica|prevé|estimaría/.test(lower)) return 'FORECAST';
  if (/opina|criticó|calificó|consideró|cuestionó/.test(lower)) return 'OPINION';
  return 'FACT';
}

function classifyStrength(text: string, mediaCount: number): QuoteStrength {
  const lower = text.toLowerCase();
  // STRONG: has numbers/attribution/multi-media
  if (mediaCount >= 2) return 'STRONG';
  if (/\d+%|\d+/.test(text)) return 'STRONG';
  if (/según|dijo|afirmó|declaró|indicó/.test(lower)) return 'STRONG';
  // WEAK: vague language
  if (/al parecer|sería|podría ser|supuestamente/.test(lower)) return 'WEAK';
  // MEDIUM: single media, factual structure
  if (text.length >= 80) return 'MEDIUM';
  return 'WEAK';
}

function classifyRole(claimType: ClaimType): QuoteRole {
  if (claimType === 'ALLEGATION') return 'ATTRIBUTION';
  if (claimType === 'OPINION') return 'ATTRIBUTION';
  return 'EVIDENCE';
}

function getTopTokens(normText: string, count: number): string[] {
  const tokens = normText.split(/\s+/).filter((t) => t.length > 3);
  const freq: Record<string, number> = {};
  for (const t of tokens) freq[t] = (freq[t] ?? 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([t]) => t);
}

function extractNumbers(text: string): string[] {
  const matches = text.match(/\d+(?:[.,]\d+)?/g);
  return matches ?? [];
}

function detectContradictions(claims: Map<string, ClaimCandidate>): void {
  const entries = Array.from(claims.entries());
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const [normA, claimA] = entries[i];
      const [normB, claimB] = entries[j];

      const tokensA = getTopTokens(normA, 5);
      const tokensB = getTopTokens(normB, 5);
      const shared = tokensA.filter((t) => tokensB.includes(t));

      if (shared.length >= 2) {
        // Check for number contradiction
        const numsA = extractNumbers(normA);
        const numsB = extractNumbers(normB);
        if (numsA.length > 0 && numsB.length > 0) {
          const hasDistinct = numsA.some((n) => !numsB.includes(n)) || numsB.some((n) => !numsA.includes(n));
          if (hasDistinct) {
            claimA.claimType = claimA.claimType; // Keep type
            claimB.claimType = claimB.claimType;
            // Mark both as contradicted - status will be set to DISPUTED in computeStatus
            (claimA as any)._contradicted = true;
            (claimB as any)._contradicted = true;
          }
        }

        // Simple negation check
        const negA = /\bno\b/.test(normA) && !/\bno\b/.test(normB);
        const negB = /\bno\b/.test(normB) && !/\bno\b/.test(normA);
        if ((negA || negB) && shared.length >= 3) {
          (claimA as any)._contradicted = true;
          (claimB as any)._contradicted = true;
        }
      }
    }
  }
}

function computeStatus(claim: ClaimCandidate): ClaimStatus {
  if ((claim as any)._contradicted) return 'DISPUTED';

  const mediaIds = new Set(claim.quotes.map((q) => q.mediaId));
  const hasStrong = claim.quotes.some((q) => q.strength === 'STRONG');
  const mediumCount = claim.quotes.filter((q) => q.strength === 'MEDIUM').length;
  const mediumMediaCount = new Set(
    claim.quotes.filter((q) => q.strength === 'MEDIUM').map((q) => q.mediaId),
  ).size;

  if (hasStrong) return 'SUPPORTED';
  if (mediumCount >= 2 && mediumMediaCount >= 2) return 'SUPPORTED';
  if (claim.quotes.every((q) => q.strength === 'WEAK')) return 'INSUFFICIENT';
  if (mediumCount === 1 && mediaIds.size === 1) return 'INSUFFICIENT';

  return 'INSUFFICIENT';
}

export class ClaimQuoteExtractor {
  private llm: LlmClient | null;

  constructor(
    private eventRepo: EventRepository,
    private versionRepo: VersionRepository,
    private mediaRepo: MediaRepository,
    private claimRepo: ClaimRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    llm?: LlmClient | null,
  ) {
    this.llm = llm ?? null;
  }

  /**
   * LLM-powered claim extraction. Returns true if it succeeded,
   * false if LLM is unavailable or failed (caller should fallback to heuristic).
   */
  private async extractWithLlm(
    articles: any[],
    eventId: string,
    versionId: string,
  ): Promise<{ claimsCount: number; quotesCount: number } | null> {
    if (!this.llm?.isAvailable()) return null;

    // Build article inputs with media keys
    const articleInputs: ArticleInput[] = await Promise.all(
      articles.map(async (a) => {
        const media = await this.mediaRepo.findById(a.mediaId);
        return {
          article_id: a.id,
          media_key: media?.mediaKey ?? 'unknown',
          title: a.title ?? '',
          snippet: a.snippet ?? '',
          url: a.url ?? '',
          published_at: a.publishedAt?.toISOString?.() ?? null,
        };
      }),
    );

    const prompt = buildClaimExtractionPrompt(articleInputs);

    try {
      const { data } = await this.llm.completeJson<{
        claims: Array<{
          claim_text: string;
          claim_type: string;
          subject?: string;
          predicate?: string;
          object?: string;
          polarity?: string;
          confidence: number;
          evidence: Array<{ source_url: string; quote: string; span_hint?: string }>;
        }>;
      }>([{ role: 'user', content: prompt }], CLAIM_EXTRACTION_SYSTEM);

      if (!data.claims || !Array.isArray(data.claims)) {
        logger.error({ eventId }, 'llm_claims_invalid_response');
        return null;
      }

      // Build URL → article lookup
      const urlToArticle = new Map<string, any>();
      for (const a of articles) {
        urlToArticle.set(a.url, a);
      }

      let claimsCount = 0;
      let quotesCount = 0;
      const seenNorm = new Set<string>();

      for (const llmClaim of data.claims) {
        if (!llmClaim.claim_text || !llmClaim.evidence?.length) continue;
        if (llmClaim.confidence < 0 || llmClaim.confidence > 1) continue;

        const normText = normalizeClaim(llmClaim.claim_text);
        if (seenNorm.has(normText)) continue;
        seenNorm.add(normText);

        const validTypes: ClaimType[] = ['FACT', 'QUANT', 'ALLEGATION', 'FORECAST', 'OPINION'];
        const claimType: ClaimType = validTypes.includes(llmClaim.claim_type as ClaimType)
          ? (llmClaim.claim_type as ClaimType)
          : classifyClaim(llmClaim.claim_text);

        // Determine status from confidence + evidence count
        const mediaKeys = new Set(llmClaim.evidence.map((e) => urlToArticle.get(e.source_url)?.mediaId).filter(Boolean));
        let status: ClaimStatus = 'INSUFFICIENT';
        if (llmClaim.confidence >= 0.7 && mediaKeys.size >= 2) status = 'SUPPORTED';
        else if (llmClaim.confidence >= 0.5) status = 'SUPPORTED';
        else if (llmClaim.polarity === 'deny') status = 'DISPUTED';

        const claim = await this.claimRepo.createClaim({
          eventId,
          versionId,
          claimText: llmClaim.claim_text,
          claimType,
          status,
        });
        claimsCount++;

        for (const ev of llmClaim.evidence) {
          const article = urlToArticle.get(ev.source_url);
          if (!article) continue;

          const quoteText = (ev.quote ?? '').slice(0, 240);
          if (!quoteText) continue;

          const sourceText = `${article.title}. ${article.snippet}`;
          const spanStart = sourceText.indexOf(quoteText.slice(0, 60));

          await this.claimRepo.createQuote({
            claimId: claim.id,
            articleId: article.id,
            quoteText,
            spanStart: spanStart >= 0 ? spanStart : null,
            spanEnd: spanStart >= 0 ? spanStart + quoteText.length : null,
            strength: mediaKeys.size >= 2 ? 'STRONG' : (quoteText.length >= 80 ? 'MEDIUM' : 'WEAK'),
            role: claimType === 'ALLEGATION' || claimType === 'OPINION' ? 'ATTRIBUTION' : 'EVIDENCE',
          });
          quotesCount++;
        }
      }

      logger.info({ eventId, claimsCount, quotesCount, mode: 'llm' }, 'claims_extracted_via_llm');
      return { claimsCount, quotesCount };
    } catch (err) {
      logger.error(
        { eventId, error: err instanceof Error ? err.message : String(err) },
        'llm_claim_extraction_failed',
      );
      return null;
    }
  }

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, version_index } = envelope.payload as {
        event_id: string;
        version_index: number;
      };
      const traceId = envelope.trace.trace_id;

      // Idempotency: check if claims already exist for this version
      const version = await this.versionRepo.findLatestByEventId(event_id);
      if (!version || version.versionIndex !== version_index) {
        logger.error({ event_id, version_index }, 'version_not_found_for_claims');
        return;
      }

      const existing = await this.claimRepo.countClaimsByVersion(event_id, version.id);
      if (existing > 0) {
        logger.info({ event_id, version_index }, 'claim_graph_already_exists');
        return;
      }

      const articles = await this.eventRepo.findArticlesForEvent(event_id);
      if (articles.length === 0) {
        logger.info({ event_id }, 'no_articles_for_claim_extraction');
        return;
      }

      // Try LLM extraction first; fallback to heuristic if unavailable or fails
      const llmResult = await this.extractWithLlm(articles, event_id, version.id);
      if (llmResult) {
        await this.auditWriter.write({
          entity_type: 'CLAIM',
          entity_id: event_id,
          action: 'CLAIM_GRAPH_BUILT',
          trace_id: traceId,
          data: { version_id: version.id, claims_count: llmResult.claimsCount, quotes_count: llmResult.quotesCount, mode: 'llm' },
        });

        await this.eventBus.publish({
          event_name: 'ClaimGraphBuilt',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'claims' },
          payload: { event_id, version_id: version.id },
        });
        return;
      }

      // ── Heuristic fallback ──────────────────────────────────────

      // Build claim candidates
      const claimsMap = new Map<string, ClaimCandidate>();
      const seenArticleClaim = new Set<string>();

      for (const article of articles) {
        const sourceText = `${article.title}. ${article.snippet}`;
        const sentences = splitSentences(sourceText);

        for (const sentence of sentences) {
          if (sentence.length < 40) continue;

          const normText = normalizeClaim(sentence);

          // Dedup: skip if same article already contributed a quote for this claim
          const dedupKey = `${article.id}::${normText}`;
          if (seenArticleClaim.has(dedupKey)) continue;
          seenArticleClaim.add(dedupKey);
          const claimType = classifyClaim(sentence);
          const quoteText = sentence.slice(0, 240);

          // Find span in source_text
          const spanStart = sourceText.indexOf(sentence);
          const spanEnd = spanStart >= 0 ? spanStart + Math.min(sentence.length, 240) : null;

          const role = classifyRole(claimType);

          if (!claimsMap.has(normText)) {
            claimsMap.set(normText, {
              claimTextNorm: normText,
              claimType,
              quotes: [],
            });
          }

          const claim = claimsMap.get(normText)!;
          // Compute media count for strength classification after dedup
          claim.quotes.push({
            articleId: article.id,
            mediaId: article.mediaId,
            quoteText,
            spanStart: spanStart >= 0 ? spanStart : null,
            spanEnd: spanEnd,
            strength: 'MEDIUM', // placeholder, recalculated below
            role,
          });
        }
      }

      // Recalculate strength based on media count per claim
      for (const claim of claimsMap.values()) {
        const mediaIds = new Set(claim.quotes.map((q) => q.mediaId));
        for (const quote of claim.quotes) {
          quote.strength = classifyStrength(quote.quoteText, mediaIds.size);
        }
      }

      // Detect contradictions
      detectContradictions(claimsMap);

      // Compute statuses
      for (const claim of claimsMap.values()) {
        // Status is computed but stored externally
      }

      // Persist claims and quotes
      let claimsCount = 0;
      let quotesCount = 0;

      for (const candidate of claimsMap.values()) {
        const status = computeStatus(candidate);

        const claim = await this.claimRepo.createClaim({
          eventId: event_id,
          versionId: version.id,
          claimText: candidate.claimTextNorm,
          claimType: candidate.claimType,
          status,
        });

        claimsCount++;

        for (const quoteCandidate of candidate.quotes) {
          await this.claimRepo.createQuote({
            claimId: claim.id,
            articleId: quoteCandidate.articleId,
            quoteText: quoteCandidate.quoteText,
            spanStart: quoteCandidate.spanStart,
            spanEnd: quoteCandidate.spanEnd,
            strength: quoteCandidate.strength,
            role: quoteCandidate.role,
          });
          quotesCount++;
        }
      }

      await this.auditWriter.write({
        entity_type: 'CLAIM',
        entity_id: event_id,
        action: 'CLAIM_GRAPH_BUILT',
        trace_id: traceId,
        data: { version_id: version.id, claims_count: claimsCount, quotes_count: quotesCount },
      });

      await this.eventBus.publish({
        event_name: 'ClaimGraphBuilt',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'claims' },
        payload: { event_id, version_id: version.id },
      });
    };
  }
}

// Export helpers for testing
export { splitSentences, normalizeClaim, classifyClaim, classifyStrength, classifyRole, computeStatus, detectContradictions };
