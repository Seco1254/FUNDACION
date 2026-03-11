import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { classifyTopic } from '../src/modules/topics/service/topic-heuristic.js';
import { evaluatePublishGate, computeImportanceScore } from '../src/core/llm/gates.js';

async function main() {
  const p = new PrismaClient();

  const events = await p.event.findMany({
    where: { state: 'PUBLISHED', canonicalEventId: null },
    orderBy: [{ publishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    include: {
      versions: { orderBy: { versionIndex: 'desc' }, take: 1 },
      eventArticles: {
        include: {
          article: {
            select: {
              id: true, url: true, status: true,
              textContentLen: true, usableForOverview: true,
              contentType: true,
              media: { select: { id: true, mediaKey: true, name: true } },
            },
          },
        },
      },
    },
  });

  console.log(`\n=== ${events.length} events (PUBLISHED, canonical) ===\n`);

  let eligibleCount = 0;
  let blockedCount = 0;

  for (const row of events) {
    const v = row.versions[0];
    const packet = (v?.packetJson as any) ?? {};
    const headline = v?.headline ?? '';

    // 1. Coherence gate
    const coherenceGate = packet.coherence_gate;
    if (coherenceGate && coherenceGate.status === 'FAIL') {
      console.log(JSON.stringify({
        id: row.id.slice(0, 12),
        headline: headline.slice(0, 60),
        BLOCKED: 'COHERENCE_GATE_FAILED',
        checks: coherenceGate.failed_checks,
      }));
      blockedCount++;
      continue;
    }

    // 2. Topic filter
    const firstUrl = row.eventArticles?.[0]?.article?.url ?? '';
    const aiWhText = Array.isArray(packet.ai_overview?.what_happened)
      ? packet.ai_overview.what_happened.join(' ') : '';
    const topic = classifyTopic({ title: headline, url: firstUrl, text: aiWhText });

    const ALLOWED = (process.env.FEED_ALLOWED_TOPICS ?? '').split(',').map(s => s.trim()).filter(Boolean);
    const filterEnabled = process.env.FEED_TOPIC_FILTER_ENABLED === '1';
    if (filterEnabled && ALLOWED.length > 0 && !ALLOWED.includes(topic.topic_key)) {
      console.log(JSON.stringify({
        id: row.id.slice(0, 12),
        headline: headline.slice(0, 60),
        BLOCKED: 'TOPIC_FILTERED',
        topic: topic.topic_key,
        allowed: ALLOWED,
      }));
      blockedCount++;
      continue;
    }

    // 3. Enrich
    const articles = row.eventArticles.map((ea: any) => ea.article);
    const mediaMap = new Map<string, number>();
    for (const a of articles) {
      const key = a.media?.mediaKey ?? 'unknown';
      mediaMap.set(key, (mediaMap.get(key) ?? 0) + 1);
    }
    const uniqueSources = mediaMap.size;
    const usable = articles.filter((a: any) => a.usableForOverview);
    const totalUsableText = usable.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0);

    // 4. Overview status
    const ai = packet.ai_overview;
    let overviewStatus = 'pending';
    if (ai) {
      const wh = Array.isArray(ai.what_happened) ? ai.what_happened : [];
      const ctx = Array.isArray(ai.context) ? ai.context : [];
      if (wh.length > 0 || ctx.length > 0) overviewStatus = 'ready';
      else overviewStatus = 'unavailable';
    }

    // 5. Importance score
    const hoursAge = row.publishedAt
      ? (Date.now() - new Date(row.publishedAt).getTime()) / (3600 * 1000) : null;
    const importance = computeImportanceScore({
      topic_key: topic.topic_key,
      text_len: totalUsableText,
      hours_since_published: hoursAge,
    });

    // 6. Publish gate
    const pageTypes = articles.map((a: any) => {
      const ct = a.contentType;
      if (ct === 'institutional_static' || ct === 'institutional') return ct;
      return 'ARTICLE';
    });
    const titleAlignment = packet.coherence_gate?.metrics?.title_jaccard ?? null;
    const hasDisclaimer = typeof ai?.why === 'string'
      && /única fuente|una fuente|una sola fuente|evidencia limitada/i.test(ai.why);

    const gate = evaluatePublishGate({
      unique_sources_count: uniqueSources,
      total_usable_text_len: totalUsableText,
      key_facts_count: packet.key_facts_count ?? 0,
      overview_status: overviewStatus,
      has_disclaimer: hasDisclaimer,
      page_types: pageTypes,
      title_alignment: titleAlignment,
      importance_score: importance,
    });

    if (gate.eligible) {
      eligibleCount++;
      console.log(JSON.stringify({
        id: row.id.slice(0, 12),
        headline: headline.slice(0, 60),
        ELIGIBLE: true,
        gate_name: gate.gate_name,
        topic: topic.topic_key,
        importance,
        sources: uniqueSources,
        text: totalUsableText,
        overview_status: overviewStatus,
      }));
    } else {
      blockedCount++;
      console.log(JSON.stringify({
        id: row.id.slice(0, 12),
        headline: headline.slice(0, 60),
        BLOCKED: 'PUBLISH_GATE',
        reasons: gate.reasons,
        topic: topic.topic_key,
        importance,
        sources: uniqueSources,
        text: totalUsableText,
        overview_status: overviewStatus,
      }));
    }
  }

  console.log(`\n=== SUMMARY: ${eligibleCount} eligible, ${blockedCount} blocked ===`);

  await p.$disconnect();
}

main().catch(console.error);
