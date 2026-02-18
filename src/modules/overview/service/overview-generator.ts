import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { logger } from '../../../core/logging/logger.js';
import type { LlmClient } from '../../../core/llm/client.js';
import {
  buildDisputeDetectionPrompt,
  DISPUTE_DETECTION_SYSTEM,
  buildOverviewPrompt,
  OVERVIEW_SYSTEM,
} from '../../../core/llm/prompts.js';
import type { ClaimInput, OverviewInput } from '../../../core/llm/prompts.js';
import { computeOverviewHash } from '../../../core/llm/dedup.js';
import {
  validateOverviewEvidence,
  validateOverviewContent,
  buildInsufficientOverview,
} from '../../../core/llm/gates.js';
import { deriveTeaser } from '../../../core/llm/teaser.js';

export interface OverviewBullet {
  claim_id: string;
  text: string;
  claim_type: string;
  status: string;
  citation_refs: CitationRef[];
}

export interface CitationRef {
  quote_id: string;
  article_id: string;
  media_key: string;
  url: string;
}

export interface OverviewSection {
  title: string;
  key: string;
  bullets: OverviewBullet[];
}

export interface OverviewResult {
  gate_status: 'PASS' | 'FAIL';
  sections: OverviewSection[];
  claims_count: number;
  quotes_count: number;
  quality_flags: {
    evidence_rate: number;
    supported_count: number;
    disputed_count: number;
  };
}

export class OverviewGenerator {
  private llm: LlmClient | null;

  constructor(
    private claimRepo: ClaimRepository,
    private versionRepo: VersionRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    llm?: LlmClient | null,
  ) {
    this.llm = llm ?? null;
  }

  /**
   * LLM-powered dispute detection + AI overview.
   * Includes anti-hallucination gates and teaser derivation.
   * Returns enriched packet fields or null on failure (caller falls back to heuristic).
   */
  private async generateWithLlm(
    claimsWithQuotes: any[],
    eventId: string,
  ): Promise<{
    overview: any;
    ai_overview: any;
    ai_teaser: string;
    mode: 'llm';
  } | null> {
    if (!this.llm?.isAvailable()) return null;
    if (claimsWithQuotes.length === 0) return null;

    // ── Gate: evidence check BEFORE calling LLM ──────────────────
    const allQuotesRaw: any[] = claimsWithQuotes.flatMap((c: any) => c.quotes ?? []);
    const allMediaKeys = new Set(
      allQuotesRaw.map((q: any) => q.article?.media?.mediaKey ?? 'unknown').filter((k: string) => k !== 'unknown'),
    );
    const evidenceCheck = validateOverviewEvidence(allMediaKeys.size, allQuotesRaw.length);
    if (!evidenceCheck.valid) {
      logger.info({ eventId, reasons: evidenceCheck.reasons }, 'ai_overview_gate_blocked');
      const heuristicOverview = this.buildOverview(claimsWithQuotes);
      const insufficient = buildInsufficientOverview(evidenceCheck.reasons);
      return {
        overview: { gate_status: heuristicOverview.gate_status, sections: heuristicOverview.sections },
        ai_overview: { ...insufficient, quality_gate_reasons: evidenceCheck.reasons },
        ai_teaser: '',
        mode: 'llm',
      };
    }

    try {
      // ── Step 1: Dispute Detection ──────────────────────────────
      const claimInputs: ClaimInput[] = claimsWithQuotes.map((c: any) => {
        const quotes: any[] = c.quotes ?? [];
        const topQuote = quotes[0]?.quoteText ?? '';
        const sourceUrls = quotes.map((q: any) => q.article?.url ?? '').filter(Boolean);
        const mediaKeys = quotes.map((q: any) => q.article?.media?.mediaKey ?? 'unknown');
        const uniqueMediaKeys = [...new Set(mediaKeys)];

        return {
          claim_id: c.id,
          claim_text: c.claimText,
          claim_type: c.claimType,
          source_urls: sourceUrls,
          media_keys: uniqueMediaKeys,
          top_quote: topQuote,
        };
      });

      const disputePrompt = buildDisputeDetectionPrompt(claimInputs);
      const { data: disputeData } = await this.llm.completeJson<{
        disputes: Array<{
          topic: string;
          point_a: { claim_text: string; source_url: string };
          point_b: { claim_text: string; source_url: string };
          why_disputed: string;
          confidence: number;
        }>;
        consensus: Array<{
          claim_text: string;
          why_consensus: string;
          confidence: number;
          evidence: Array<{ source_url: string; quote: string }>;
        }>;
      }>([{ role: 'user', content: disputePrompt }], DISPUTE_DETECTION_SYSTEM);

      const disputes = Array.isArray(disputeData.disputes) ? disputeData.disputes : [];
      const consensus = Array.isArray(disputeData.consensus) ? disputeData.consensus : [];

      logger.info(
        { eventId, disputes: disputes.length, consensus: consensus.length },
        'dispute_detection_completed',
      );

      // ── Step 2: AI Overview ────────────────────────────────────
      const allQuotes: any[] = claimsWithQuotes.flatMap((c: any) => (c.quotes ?? []).map((q: any) => ({
        quote: q.quoteText ?? '',
        media_key: q.article?.media?.mediaKey ?? 'unknown',
        url: q.article?.url ?? '',
      })));
      const uniqueSources = new Set(allQuotes.map((q: any) => q.media_key));

      const overviewInput: OverviewInput = {
        consensus: consensus.map((c) => ({
          claim_text: c.claim_text,
          why_consensus: c.why_consensus,
          confidence: Math.max(0, Math.min(1, c.confidence ?? 0)),
        })),
        disputes: disputes.map((d) => ({
          topic: d.topic,
          why_disputed: d.why_disputed,
          confidence: Math.max(0, Math.min(1, d.confidence ?? 0)),
        })),
        top_quotes: allQuotes.slice(0, 10),
        claims_count: claimsWithQuotes.length,
        sources_count: uniqueSources.size,
      };

      const overviewPrompt = buildOverviewPrompt(overviewInput);
      const { data: aiOverview } = await this.llm.completeJson<{
        overview: string;
        what_happened: string[];
        context: string[];
        in_dispute: string[];
        confidence_label: string;
        why: string;
      }>([{ role: 'user', content: overviewPrompt }], OVERVIEW_SYSTEM);

      // ── Gate: validate LLM output content ──────────────────────
      const contentCheck = validateOverviewContent(aiOverview);
      if (!contentCheck.valid) {
        logger.info({ eventId, reasons: contentCheck.reasons }, 'ai_overview_content_gate_blocked');
        const heuristicOverview = this.buildOverview(claimsWithQuotes);
        const insufficient = buildInsufficientOverview(contentCheck.reasons);
        return {
          overview: { gate_status: heuristicOverview.gate_status, sections: heuristicOverview.sections },
          ai_overview: { ...insufficient, quality_gate_reasons: contentCheck.reasons },
          ai_teaser: '',
          mode: 'llm',
        };
      }

      const validLabels = ['Alta', 'Media', 'Baja', 'No concluyente'];
      const confidenceLabel = validLabels.includes(aiOverview.confidence_label)
        ? aiOverview.confidence_label
        : 'No concluyente';

      const whatHappened = Array.isArray(aiOverview.what_happened) ? aiOverview.what_happened : [];
      const aiTeaser = deriveTeaser(whatHappened);

      logger.info(
        { eventId, confidence_label: confidenceLabel, teaser_len: aiTeaser.length, mode: 'llm' },
        'ai_overview_generated',
      );

      const heuristicOverview = this.buildOverview(claimsWithQuotes);

      return {
        overview: {
          gate_status: heuristicOverview.gate_status,
          sections: heuristicOverview.sections,
        },
        ai_overview: {
          overview: aiOverview.overview ?? '',
          what_happened: whatHappened,
          context: Array.isArray(aiOverview.context) ? aiOverview.context : [],
          in_dispute: Array.isArray(aiOverview.in_dispute) ? aiOverview.in_dispute : [],
          confidence_label: confidenceLabel,
          why: aiOverview.why ?? '',
          disputes: disputes.map((d) => ({
            topic: d.topic,
            point_a: d.point_a,
            point_b: d.point_b,
            why_disputed: d.why_disputed,
            confidence: d.confidence,
          })),
          consensus: consensus.map((c) => ({
            claim_text: c.claim_text,
            why_consensus: c.why_consensus,
            confidence: c.confidence,
          })),
        },
        ai_teaser: aiTeaser,
        mode: 'llm',
      };
    } catch (err) {
      logger.error(
        { eventId, error: err instanceof Error ? err.message : String(err) },
        'llm_overview_generation_failed',
      );
      return null;
    }
  }

  handler(): EventHandler {
    return async (envelope: EventEnvelope): Promise<void> => {
      const { event_id, version_id } = envelope.payload as {
        event_id: string;
        version_id: string;
      };
      const traceId = envelope.trace.trace_id;

      const claimsWithQuotes = await this.claimRepo.findClaimsWithQuotesByVersion(event_id, version_id);

      if (claimsWithQuotes.length === 0) {
        logger.info({ event_id, version_id }, 'no_claims_for_overview');
      }

      const version = await this.versionRepo.findById(version_id);
      const existingPacket = (version?.packetJson as any) ?? {};

      // ── Dedupe: compute overview hash, skip LLM if input unchanged ──
      const existingHashes = existingPacket._ai_hashes ?? {};
      const claimsHash = existingHashes.claims_hash ?? '';
      const newOverviewHash = computeOverviewHash(version_id, claimsHash);

      if (existingHashes.overview_hash === newOverviewHash && existingPacket.ai_overview) {
        logger.info({ event_id, version_id, overview_hash: newOverviewHash }, 'dedup_hit_overview');
        // Still emit OverviewGenerated for downstream subscribers
        await this.eventBus.publish({
          event_name: 'OverviewGenerated',
          event_id: ulid(),
          occurred_at: new Date().toISOString(),
          trace: { trace_id: traceId, span_id: ulid(), source_module: 'overview' },
          payload: { event_id, version_id, version_index: version?.versionIndex ?? 0, gate_status: existingPacket.overview?.gate_status ?? 'FAIL' },
        });
        return;
      }

      // Try LLM path first; fallback to heuristic
      const llmResult = await this.generateWithLlm(claimsWithQuotes, event_id);
      let computedGateStatus: 'PASS' | 'FAIL';

      if (llmResult) {
        const heuristicOverview = llmResult.overview;
        computedGateStatus = heuristicOverview.gate_status;

        const totalQuotes = claimsWithQuotes.reduce((sum: number, c: any) => sum + ((c.quotes ?? []).length), 0);
        const supportedCount = claimsWithQuotes.filter((c: any) => c.status === 'SUPPORTED').length;
        const disputedCount = claimsWithQuotes.filter((c: any) => c.status === 'DISPUTED').length;

        const updatedPacket = {
          ...existingPacket,
          overview: heuristicOverview,
          ai_overview: llmResult.ai_overview,
          ai_teaser: llmResult.ai_teaser,
          claims_count: claimsWithQuotes.length,
          quotes_count: totalQuotes,
          quality_flags: {
            evidence_rate: claimsWithQuotes.length > 0 ? supportedCount / claimsWithQuotes.length : 0,
            supported_count: supportedCount,
            disputed_count: disputedCount,
          },
          overview_mode: 'llm',
          _ai_hashes: {
            ...existingHashes,
            overview_hash: newOverviewHash,
          },
        };

        if (version) {
          await this.versionRepo.update(version_id, {
            packetJson: updatedPacket,
            gateStatus: computedGateStatus,
          });
        }

        await this.auditWriter.write({
          entity_type: 'OVERVIEW',
          entity_id: event_id,
          action: 'OVERVIEW_GENERATED',
          trace_id: traceId,
          data: {
            version_id,
            gate_status: computedGateStatus,
            claims_count: claimsWithQuotes.length,
            mode: 'llm',
            overview_hash: newOverviewHash,
          },
        });
      } else {
        // Heuristic fallback
        const overview = this.buildOverview(claimsWithQuotes);
        computedGateStatus = overview.gate_status;

        if (version) {
          const updatedPacket = {
            ...existingPacket,
            overview: {
              gate_status: overview.gate_status,
              sections: overview.sections,
            },
            claims_count: overview.claims_count,
            quotes_count: overview.quotes_count,
            quality_flags: overview.quality_flags,
          };

          await this.versionRepo.update(version_id, {
            packetJson: updatedPacket,
            gateStatus: overview.gate_status,
          });
        }

        await this.auditWriter.write({
          entity_type: 'OVERVIEW',
          entity_id: event_id,
          action: 'OVERVIEW_GENERATED',
          trace_id: traceId,
          data: {
            version_id,
            gate_status: overview.gate_status,
            claims_count: overview.claims_count,
            quotes_count: overview.quotes_count,
          },
        });
      }

      await this.eventBus.publish({
        event_name: 'OverviewGenerated',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'overview' },
        payload: { event_id, version_id, version_index: version?.versionIndex ?? 0, gate_status: computedGateStatus },
      });
    };
  }

  buildOverview(claimsWithQuotes: any[]): OverviewResult {
    const quePaso: OverviewBullet[] = [];
    const contexto: OverviewBullet[] = [];
    const enDisputa: OverviewBullet[] = [];
    const queFalta: OverviewBullet[] = [];

    let totalQuotes = 0;

    for (const claim of claimsWithQuotes) {
      const quotes: any[] = claim.quotes ?? [];
      const citations: CitationRef[] = quotes.map((q: any) => ({
        quote_id: q.id,
        article_id: q.articleId,
        media_key: q.article?.media?.mediaKey ?? 'unknown',
        url: q.article?.url ?? '',
      }));

      totalQuotes += quotes.length;

      // HARD RULE: no bullet without citation_refs
      if (citations.length === 0) continue;

      const bullet: OverviewBullet = {
        claim_id: claim.id,
        text: claim.claimText,
        claim_type: claim.claimType,
        status: claim.status,
        citation_refs: citations,
      };

      if (claim.status === 'INSUFFICIENT') {
        // RULE: INSUFFICIENT → only in "Qué falta por confirmar"
        queFalta.push(bullet);
      } else if (claim.status === 'DISPUTED') {
        // RULE: DISPUTED → only in "En disputa", must include >=2 citations
        if (citations.length >= 2) {
          enDisputa.push(bullet);
        } else {
          enDisputa.push(bullet);
        }
      } else {
        // SUPPORTED claims
        if (claim.claimType === 'FACT' || claim.claimType === 'QUANT') {
          quePaso.push(bullet);
        } else if (claim.claimType === 'ALLEGATION' || claim.claimType === 'ATTRIBUTION') {
          contexto.push(bullet);
        } else {
          contexto.push(bullet);
        }
      }
    }

    const sections: OverviewSection[] = [
      { title: 'Qué pasó', key: 'que_paso', bullets: quePaso },
      { title: 'Contexto', key: 'contexto', bullets: contexto },
      { title: 'En disputa', key: 'en_disputa', bullets: enDisputa },
      { title: 'Qué falta por confirmar', key: 'que_falta', bullets: queFalta },
    ];

    const supportedCount = claimsWithQuotes.filter((c: any) => c.status === 'SUPPORTED').length;
    const disputedCount = claimsWithQuotes.filter((c: any) => c.status === 'DISPUTED').length;

    // All bullets across sections
    const allBullets = sections.flatMap((s) => s.bullets);
    const allBulletsHaveCitations = allBullets.every((b) => b.citation_refs.length > 0);

    // Gate logic
    let gateStatus: 'PASS' | 'FAIL';
    if (supportedCount >= 2 && allBullets.length > 0 && allBulletsHaveCitations) {
      gateStatus = 'PASS';
    } else {
      gateStatus = 'FAIL';
    }

    // If FAIL: minimal overview - only "Qué falta por confirmar"
    if (gateStatus === 'FAIL') {
      // Move everything to queFalta if there are insufficient claims with citations
      const minimalSections: OverviewSection[] = [
        { title: 'Qué pasó', key: 'que_paso', bullets: [] },
        { title: 'Contexto', key: 'contexto', bullets: [] },
        { title: 'En disputa', key: 'en_disputa', bullets: enDisputa },
        { title: 'Qué falta por confirmar', key: 'que_falta', bullets: queFalta },
      ];

      return {
        gate_status: 'FAIL',
        sections: minimalSections,
        claims_count: claimsWithQuotes.length,
        quotes_count: totalQuotes,
        quality_flags: {
          evidence_rate: claimsWithQuotes.length > 0 ? supportedCount / claimsWithQuotes.length : 0,
          supported_count: supportedCount,
          disputed_count: disputedCount,
        },
      };
    }

    return {
      gate_status: gateStatus,
      sections,
      claims_count: claimsWithQuotes.length,
      quotes_count: totalQuotes,
      quality_flags: {
        evidence_rate: claimsWithQuotes.length > 0 ? supportedCount / claimsWithQuotes.length : 0,
        supported_count: supportedCount,
        disputed_count: disputedCount,
      },
    };
  }
}
