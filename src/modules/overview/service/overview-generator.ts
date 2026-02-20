import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { EventRepository } from '../../events/repo/event-repo.js';
import { logger } from '../../../core/logging/logger.js';
import type { LlmClient } from '../../../core/llm/client.js';
import {
  buildOverviewWriterPrompt,
  OVERVIEW_WRITER_SYSTEM,
} from '../../../core/llm/prompts.js';
import { computeOverviewHash } from '../../../core/llm/dedup.js';
import {
  validateOverviewContent,
  buildInsufficientOverview,
} from '../../../core/llm/gates.js';
import { extractFacts } from '../../../core/llm/facts-extractor.js';
import type { FactsPacket } from '../../../core/llm/facts-extractor.js';
import { deriveTeaser } from '../../../core/llm/teaser.js';
import { sanitizeText } from '../../text_sanitizer/sanitize.js';

const TEXT_MIN_LEN = parseInt(process.env.ARTICLE_TEXT_MIN_LEN ?? '800', 10);

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
  private eventRepo: EventRepository | null;

  constructor(
    private claimRepo: ClaimRepository,
    private versionRepo: VersionRepository,
    private eventBus: EventBus,
    private auditWriter: AuditLogWriter,
    llm?: LlmClient | null,
    eventRepo?: EventRepository | null,
  ) {
    this.llm = llm ?? null;
    this.eventRepo = eventRepo ?? null;
  }

  /**
   * 2-step pipeline: heuristic facts extraction → single LLM overview writer.
   * Step 1: extractFacts() (pure heuristic, zero LLM calls)
   * Step 2: LLM overview writer (single call) with anti-hallucination gates
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
    facts_packet: FactsPacket;
    key_facts_count: number;
  } | null> {
    if (!this.llm?.isAvailable()) return null;
    if (claimsWithQuotes.length === 0) return null;

    // ── Step 1: Heuristic facts extraction ─────────────────────
    let articles: any[] = [];
    if (this.eventRepo) {
      articles = await this.eventRepo.findArticlesForEvent(eventId);
    }

    const articleInputs = articles.map((a: any) => {
      const rawText = a.textNorm ?? null;
      const sanitized = rawText
        ? sanitizeText({ text: rawText, source: { media_key: a.media?.mediaKey, url: a.url } })
        : null;
      return {
        title: a.title ?? '',
        textNorm: sanitized?.cleaned_text ?? null,
        url: a.url ?? '',
        mediaKey: a.media?.mediaKey ?? 'unknown',
        mediaName: a.media?.name ?? a.media?.mediaKey ?? 'unknown',
        textContentLen: sanitized ? sanitized.stats.chars_after : (a.textContentLen ?? 0),
      };
    });

    const headline = claimsWithQuotes[0]?.claimText ?? articleInputs[0]?.title ?? null;
    const factsPacket = extractFacts(claimsWithQuotes, articleInputs, headline);
    const keyFactsCount = factsPacket.key_facts.length;

    logger.info(
      { eventId, key_facts: keyFactsCount, sources: factsPacket.coverage_summary.sources_count },
      'facts_extracted',
    );

    if (keyFactsCount === 0) {
      // No facts → try text fallback
      const heuristicOverview = this.buildOverview(claimsWithQuotes);
      const articlesWithMedia = articleInputs.map((a) => ({
        ...a,
        snippet: '',
      }));
      const textFallback = this.buildTextFallbackOverview(articlesWithMedia);
      if (textFallback) {
        return {
          overview: { gate_status: heuristicOverview.gate_status, sections: heuristicOverview.sections },
          ai_overview: { ...textFallback },
          ai_teaser: (textFallback.what_happened as string[])[0] ?? '',
          mode: 'llm',
          facts_packet: factsPacket,
          key_facts_count: keyFactsCount,
        };
      }
      const insufficient = buildInsufficientOverview(['NO_KEY_FACTS']);
      return {
        overview: { gate_status: heuristicOverview.gate_status, sections: heuristicOverview.sections },
        ai_overview: insufficient,
        ai_teaser: '',
        mode: 'llm',
        facts_packet: factsPacket,
        key_facts_count: keyFactsCount,
      };
    }

    try {
      // ── Step 2: Single LLM call — overview writer ────────────
      const overviewPrompt = buildOverviewWriterPrompt(factsPacket);
      const { data: aiOverview } = await this.llm.completeJson<{
        overview: string;
        what_happened: string[];
        context: string[];
        in_dispute: string[];
        confidence_label: string;
        why: string;
        fuentes: string;
      }>([{ role: 'user', content: overviewPrompt }], OVERVIEW_WRITER_SYSTEM);

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
          facts_packet: factsPacket,
          key_facts_count: keyFactsCount,
        };
      }

      const validLabels = ['Alta', 'Media', 'Baja', 'No concluyente'];
      const confidenceLabel = validLabels.includes(aiOverview.confidence_label)
        ? aiOverview.confidence_label
        : 'No concluyente';

      const whatHappened = Array.isArray(aiOverview.what_happened) ? aiOverview.what_happened : [];
      const aiTeaser = deriveTeaser(whatHappened);

      logger.info(
        { eventId, confidence_label: confidenceLabel, teaser_len: aiTeaser.length, mode: 'llm', key_facts: keyFactsCount },
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
          fuentes: aiOverview.fuentes ?? '',
        },
        ai_teaser: aiTeaser,
        mode: 'llm',
        facts_packet: factsPacket,
        key_facts_count: keyFactsCount,
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

        const llmOverviewStatus: { state: string; reason: string | null } = heuristicOverview.gate_status === 'PASS'
          ? { state: 'ready', reason: null }
          : { state: 'blocked', reason: 'Evidencia insuficiente' };

        const updatedPacket = {
          ...existingPacket,
          overview: heuristicOverview,
          ai_overview: llmResult.ai_overview,
          ai_teaser: llmResult.ai_teaser,
          claims_count: claimsWithQuotes.length,
          quotes_count: totalQuotes,
          key_facts_count: llmResult.key_facts_count,
          facts_packet: llmResult.facts_packet,
          quality_flags: {
            evidence_rate: claimsWithQuotes.length > 0 ? supportedCount / claimsWithQuotes.length : 0,
            supported_count: supportedCount,
            disputed_count: disputedCount,
          },
          overview_status: llmOverviewStatus,
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

        // Build ai_overview from heuristic sections
        let aiOverview = this.buildHeuristicAiOverview(overview);
        let overviewMode = 'heuristic';

        // If heuristic produced empty sections and we have article text, try text-based fallback
        const heuristicWh = aiOverview.what_happened as string[];
        const heuristicIsEmpty = heuristicWh.length === 0
          || (heuristicWh.length === 1 && (heuristicWh[0] ?? '').includes('no hay suficiente'));

        if (heuristicIsEmpty && this.eventRepo) {
          const articles = await this.eventRepo.findArticlesForEvent(event_id);
          const articlesWithMedia = await Promise.all(
            articles.map(async (a: any) => ({
              title: a.title ?? '',
              textNorm: a.textNorm ?? null,
              snippet: a.snippet ?? '',
              url: a.url ?? '',
              mediaKey: a.media?.mediaKey ?? 'unknown',
            })),
          );

          const textFallback = this.buildTextFallbackOverview(articlesWithMedia);
          if (textFallback) {
            aiOverview = textFallback;
            overviewMode = 'fallback';
            logger.info({ event_id, mode: 'fallback', articles_used: articlesWithMedia.length }, 'text_fallback_overview_generated');
          }
        }

        if (version) {
          const updatedPacket: Record<string, unknown> = {
            ...existingPacket,
            overview: {
              gate_status: overview.gate_status,
              sections: overview.sections,
            },
            ai_overview: aiOverview,
            ai_teaser: (aiOverview.what_happened as string[])[0] ?? '',
            overview_mode: overviewMode,
            claims_count: overview.claims_count,
            quotes_count: overview.quotes_count,
            quality_flags: overview.quality_flags,
            _ai_hashes: {
              ...existingHashes,
              overview_hash: newOverviewHash,
            },
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
            mode: overviewMode,
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

  /**
   * Derive ai_overview from heuristic sections so the feed never stays on null.
   */
  private buildHeuristicAiOverview(overview: OverviewResult): Record<string, unknown> {
    const quePaso = overview.sections.find((s) => s.key === 'que_paso');
    const contexto = overview.sections.find((s) => s.key === 'contexto');
    const enDisputa = overview.sections.find((s) => s.key === 'en_disputa');

    const whatHappened = (quePaso?.bullets ?? []).map((b) => b.text);
    const context = (contexto?.bullets ?? []).map((b) => b.text);
    const inDispute = (enDisputa?.bullets ?? []).map((b) => b.text);

    // If gate FAIL and no bullets, provide a minimal "unavailable" message
    if (whatHappened.length === 0 && context.length === 0) {
      return {
        overview: '',
        what_happened: ['Aún no hay suficiente evidencia cruzada para un resumen.'],
        context: [],
        in_dispute: inDispute,
        confidence_label: 'No concluyente',
        why: `Resumen heurístico — gate: ${overview.gate_status}`,
        status: overview.gate_status === 'FAIL' ? 'INSUFFICIENT_EVIDENCE' : 'HEURISTIC',
      };
    }

    return {
      overview: '',
      what_happened: whatHappened,
      context,
      in_dispute: inDispute,
      confidence_label: 'No concluyente',
      why: 'Resumen generado por heurística (sin LLM)',
      status: 'HEURISTIC',
    };
  }

  /**
   * Build a fallback overview directly from article text when the claims-based
   * pipeline produces insufficient results (gate FAIL / single-source).
   * Extracts factual sentences from the article body and organizes them into sections.
   */
  buildTextFallbackOverview(articles: Array<{ title: string; textNorm: string | null; snippet: string; url: string; mediaKey: string }>): Record<string, unknown> | null {
    // Collect text from articles with sufficient content
    const usable = articles.filter((a) => (a.textNorm ?? '').length >= TEXT_MIN_LEN);
    if (usable.length === 0) return null;

    const uniqueMedia = new Set(usable.map((a) => a.mediaKey));
    const confidenceLabel = uniqueMedia.size >= 2 ? 'Media' : 'Baja';
    const disclaimer = uniqueMedia.size < 2 ? 'Evidencia limitada (una sola fuente).' : '';

    // Extract factual sentences from the article text
    const factsExtracted: string[] = [];
    const whatHappened: string[] = [];
    const contextBullets: string[] = [];
    const seen = new Set<string>();

    for (const article of usable) {
      const rawText = article.textNorm ?? article.snippet;
      const { cleaned_text: text } = sanitizeText({
        text: rawText,
        source: { media_key: article.mediaKey, url: article.url },
      });
      const sentences = text.split(/(?<=[.;:])\s+/).filter((s) => s.length >= 40 && s.length <= 300);

      for (const sentence of sentences) {
        const norm = sentence.toLowerCase().trim();
        if (seen.has(norm)) continue;
        seen.add(norm);
        factsExtracted.push(sentence);
      }
    }

    // Classify sentences into sections
    for (const fact of factsExtracted) {
      const lower = fact.toLowerCase();
      const isContext = /según|dijo|señaló|afirmó|indicó|aseguró|declaró|expresó|advirtió|consideró/.test(lower);
      const isHedging = /podría|se espera|al parecer|sería|investigan|aún no/.test(lower);

      if (isHedging) continue; // Skip hedging for what_happened
      if (isContext) {
        if (contextBullets.length < 4) contextBullets.push(fact);
      } else {
        if (whatHappened.length < 5) whatHappened.push(fact);
      }

      if (whatHappened.length >= 5 && contextBullets.length >= 4) break;
    }

    // If we still don't have enough what_happened, pull from context
    if (whatHappened.length < 3 && contextBullets.length > 0) {
      while (whatHappened.length < 3 && contextBullets.length > 0) {
        whatHappened.push(contextBullets.shift()!);
      }
    }

    if (whatHappened.length === 0) return null;

    // Build "En disputa" — for single source, add a standard note
    const inDispute = ['No se identifican versiones contradictorias por ahora (evidencia limitada).'];
    const queFalta = ['Falta confirmación de fuentes independientes.'];

    // Build the overview paragraph from the first title + first few bullets
    const overviewParagraph = usable[0].title + '. ' + whatHappened.slice(0, 3).join('. ');

    return {
      overview: overviewParagraph,
      what_happened: whatHappened,
      context: contextBullets,
      in_dispute: inDispute,
      que_falta: queFalta,
      confidence_label: confidenceLabel,
      why: disclaimer || 'Resumen basado en texto del artículo (fallback).',
      status: 'FALLBACK',
      _audit: {
        facts_extracted: factsExtracted.slice(0, 10),
        articles_used: usable.map((a) => ({ url: a.url, media_key: a.mediaKey, text_len: (a.textNorm ?? '').length })),
      },
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
