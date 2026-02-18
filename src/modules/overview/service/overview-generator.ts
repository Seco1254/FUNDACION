import { ulid } from 'ulid';
import { EventBus, EventHandler, EventEnvelope } from '../../../core/event_bus/index.js';
import { AuditLogWriter } from '../../../core/event_bus/dispatcher.js';
import { ClaimRepository } from '../../claims/repo/claim-repo.js';
import { VersionRepository } from '../../versions/repo/version-repo.js';
import { logger } from '../../../core/logging/logger.js';

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
  constructor(
    private claimRepo: ClaimRepository,
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

      const claimsWithQuotes = await this.claimRepo.findClaimsWithQuotesByVersion(event_id, version_id);

      if (claimsWithQuotes.length === 0) {
        logger.info({ event_id, version_id }, 'no_claims_for_overview');
      }

      const overview = this.buildOverview(claimsWithQuotes);

      // Update packet_json in the version
      const version = await this.versionRepo.findById(version_id);
      if (version) {
        const existingPacket = (version.packetJson as any) ?? {};
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

      await this.eventBus.publish({
        event_name: 'OverviewGenerated',
        event_id: ulid(),
        occurred_at: new Date().toISOString(),
        trace: { trace_id: traceId, span_id: ulid(), source_module: 'overview' },
        payload: { event_id, version_id, version_index: version?.versionIndex ?? 0, gate_status: overview.gate_status },
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
