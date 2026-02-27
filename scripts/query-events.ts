import '../src/env.js';
import { PrismaClient } from '@prisma/client';
import { classifyTopic } from '../src/modules/topics/service/topic-heuristic.js';

async function main() {
  const p = new PrismaClient();

  const events = await p.event.findMany({
    where: { state: 'PUBLISHED' },
    select: {
      id: true,
      versions: {
        select: { headline: true, packetJson: true },
        orderBy: { versionIndex: 'desc' as const },
        take: 1,
      },
      eventArticles: {
        select: {
          article: {
            select: {
              id: true,
              title: true,
              url: true,
              textContentLen: true,
              status: true,
              media: { select: { mediaKey: true, name: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  console.log(`\n=== ${events.length} PUBLISHED events ===\n`);

  const topicCounts: Record<string, number> = {};

  for (const e of events) {
    const v = e.versions[0];
    const pkt = v?.packetJson as any;
    const headline = v?.headline ?? null;
    const articles = e.eventArticles
      .map((ea: any) => ea.article)
      .filter((a: any) => a.status === 'POLICY_OK');

    const firstArticleUrl = articles[0]?.url ?? '';
    // Replicate what feed-service does:
    const aiWhText = Array.isArray(pkt?.ai_overview?.what_happened)
      ? pkt.ai_overview.what_happened.join(' ')
      : '';

    const topic = classifyTopic({ title: headline, url: firstArticleUrl, text: aiWhText });

    const sources = [...new Set(articles.map((a: any) => a.media?.mediaKey))];
    topicCounts[topic.topic_key] = (topicCounts[topic.topic_key] ?? 0) + 1;

    console.log(JSON.stringify({
      id: e.id.slice(0, 12),
      headline: headline?.slice(0, 90),
      topic_key: topic.topic_key,
      topic_score: topic.score,
      topic_reasons: topic.reasons,
      articles_ok: articles.length,
      sources,
      total_text: articles.reduce((s: number, a: any) => s + (a.textContentLen ?? 0), 0),
      overview_status: pkt?.overview_status ?? null,
    }));
  }

  console.log('\n=== TOPIC DISTRIBUTION ===');
  console.log(JSON.stringify(topicCounts, null, 2));

  await p.$disconnect();
}

main().catch(console.error);
