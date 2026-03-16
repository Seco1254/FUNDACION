/**
 * Cross-reference LLM decisions with article/event media sources
 * to determine if any cross-source pairs reached the LLM.
 */
import '../src/env.js';
import { prisma } from '../src/db/client.js';
import * as fs from 'fs';

async function main() {
  // Read log file
  const logPath = process.argv[2] || '/tmp/v31-llm-on.log';
  const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

  // Extract LLM verify decisions
  const decisions: Array<{
    article_id: string;
    event_id: string;
    verdict: string;
    article_title: string;
    event_title: string;
  }> = [];

  // Also extract cross-source heuristic fallbacks
  let crossSourceFallbacks = 0;

  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.msg === 'llm_verify_result') {
        // Need to find the linker_decision that matches
        decisions.push({
          article_id: d.article_id || '',
          event_id: d.event_id || '',
          verdict: d.verdict,
          article_title: d.article_title || '',
          event_title: d.event_title || '',
        });
      }
      if (d.msg === 'cross_source_heuristic_fallback') {
        crossSourceFallbacks++;
      }
    } catch {}
  }

  // For each linker decision with llmUsed=true, find article and event media
  const llmDecisions: Array<{
    article_id: string;
    event_id: string;
    verdict: string;
    linkType: string;
  }> = [];
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.msg === 'linker_decision' && d.llmUsed === true) {
        llmDecisions.push({
          article_id: d.article_id,
          event_id: d.topCandidateEventId,
          verdict: d.decision,
          linkType: d.linkType,
        });
      }
    } catch {}
  }

  // Also find all MAYBE_LINK decisions (with or without LLM)
  const maybeLinkDecisions: Array<{
    article_id: string;
    event_id: string;
    decision: string;
    llmUsed: boolean;
    score: number;
  }> = [];
  for (const line of lines) {
    try {
      const d = JSON.parse(line);
      if (d.msg === 'linker_decision' && d.topScore >= 0.28 && d.topScore < 0.45) {
        maybeLinkDecisions.push({
          article_id: d.article_id,
          event_id: d.topCandidateEventId,
          decision: d.decision,
          llmUsed: d.llmUsed,
          score: d.topScore,
        });
      }
    } catch {}
  }

  // Get article media info
  const articles = await prisma.article.findMany({
    select: { id: true, title: true, mediaId: true, media: { select: { name: true } } },
  });
  const artMap = new Map(articles.map(a => [a.id, a]));

  // For each MAYBE_LINK decision, check if it's cross-source
  console.log(`\n=== MAYBE_LINK zone decisions (score 0.28-0.45) ===`);
  console.log(`Total: ${maybeLinkDecisions.length}`);

  let csCount = 0;
  for (const md of maybeLinkDecisions) {
    const art = artMap.get(md.article_id);
    if (!art) continue;

    // Get event's article media
    const eventArts = await prisma.eventArticle.findMany({
      where: { eventId: md.event_id },
      include: { article: { select: { mediaId: true, media: { select: { name: true } } } } },
    });
    const eventMediaIds = new Set(eventArts.map(ea => ea.article.mediaId));
    const isCrossSource = art.mediaId && !eventMediaIds.has(art.mediaId);

    if (isCrossSource) {
      csCount++;
      const eventMediaNames = [...new Set(eventArts.map(ea => ea.article.media?.name))].join(', ');
      console.log(`  [CROSS-SOURCE] ${md.decision} (llm=${md.llmUsed}) score=${md.score.toFixed(4)}`);
      console.log(`    Article: [${art.media?.name}] ${art.title.slice(0, 70)}`);
      console.log(`    Event: [${eventMediaNames}] (${eventArts.length} arts)`);
      console.log();
    }
  }
  console.log(`Cross-source in MAYBE_LINK zone: ${csCount}`);

  // Also check LLM decisions for cross-source
  console.log(`\n=== LLM decisions that were cross-source ===`);
  for (const ld of llmDecisions) {
    const art = artMap.get(ld.article_id);
    if (!art) continue;
    const eventArts = await prisma.eventArticle.findMany({
      where: { eventId: ld.event_id },
      include: { article: { select: { mediaId: true, media: { select: { name: true } } } } },
    });
    const eventMediaIds = new Set(eventArts.map(ea => ea.article.mediaId));
    const isCrossSource = art.mediaId && !eventMediaIds.has(art.mediaId);
    if (isCrossSource) {
      const eventMediaNames = [...new Set(eventArts.map(ea => ea.article.media?.name))].join(', ');
      console.log(`  [${ld.verdict}] Article: [${art.media?.name}] ${art.title.slice(0, 60)}`);
      console.log(`    Event: [${eventMediaNames}]`);
    }
  }

  console.log(`\nCross-source heuristic fallbacks: ${crossSourceFallbacks}`);
  console.log(`Total LLM decisions: ${decisions.length}`);
  console.log(`LLM-used linker decisions: ${llmDecisions.length}`);

  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });
