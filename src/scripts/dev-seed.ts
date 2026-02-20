import { PrismaClient } from '@prisma/client';
import { logger } from '../core/logging/logger.js';

const SEED_EVENTS = [
  {
    headline: 'Gobierno anuncia nueva reforma tributaria',
    articles: [
      {
        mediaKey: 'dev-seed-media',
        mediaName: 'Demo Media',
        url: 'https://demo.local/reforma-tributaria',
        title: 'Reforma tributaria: lo que se sabe',
        snippet: 'El gobierno colombiano presentó un proyecto de ley para reformar el sistema tributario.',
        textLen: 1200,
      },
      {
        mediaKey: 'dev-seed-media-2',
        mediaName: 'Demo Noticias',
        url: 'https://demo.local/reforma-impuestos',
        title: 'Impuestos subirán con nueva reforma',
        snippet: 'La reforma incluye cambios en el IVA y en el impuesto de renta para personas naturales.',
        textLen: 900,
      },
    ],
  },
  {
    headline: 'Protestas en Bogotá por crisis de transporte',
    articles: [
      {
        mediaKey: 'dev-seed-media',
        mediaName: 'Demo Media',
        url: 'https://demo.local/protestas-bogota',
        title: 'Miles marchan contra TransMilenio',
        snippet: 'Ciudadanos salieron a las calles para protestar por el mal servicio de TransMilenio.',
        textLen: 800,
      },
    ],
  },
  {
    headline: 'Selección Colombia clasifica al Mundial',
    articles: [
      {
        mediaKey: 'dev-seed-media-3',
        mediaName: 'Deportes Hoy',
        url: 'https://demo.local/colombia-mundial',
        title: 'Colombia al Mundial tras vencer a Perú',
        snippet: 'La selección colombiana derrotó 2-0 a Perú en Lima y aseguró su cupo al Mundial.',
        textLen: 1500,
      },
      {
        mediaKey: 'dev-seed-media',
        mediaName: 'Demo Media',
        url: 'https://demo.local/colombia-celebra',
        title: 'Colombia celebra clasificación mundialista',
        snippet: 'Fiestas en todo el país tras la clasificación de la selección.',
        textLen: 600,
      },
    ],
  },
];

export async function runDevSeed(prisma: PrismaClient): Promise<number> {
  const eventCount = await prisma.event.count();
  if (eventCount > 0) {
    logger.info({ existing_events: eventCount }, 'dev_seed_skip_events_exist');
    return 0;
  }

  const now = new Date();
  let seeded = 0;

  for (const seed of SEED_EVENTS) {
    // Upsert media
    const mediaIds = new Map<string, string>();
    for (const art of seed.articles) {
      let media = await prisma.media.findUnique({ where: { mediaKey: art.mediaKey } });
      if (!media) {
        media = await prisma.media.create({
          data: { mediaKey: art.mediaKey, name: art.mediaName, allowlisted: true },
        });
      }
      mediaIds.set(art.mediaKey, media.id);
    }

    // Create event as PUBLISHED
    const event = await prisma.event.create({
      data: {
        state: 'PUBLISHED',
        t0: now,
        tLast: now,
        publishAt: now,
        publishedAt: now,
      },
    });

    // Create articles and link to event
    for (const art of seed.articles) {
      const existing = await prisma.article.findUnique({ where: { url: art.url } });
      if (existing) continue;

      const article = await prisma.article.create({
        data: {
          mediaId: mediaIds.get(art.mediaKey)!,
          url: art.url,
          title: art.title,
          snippet: art.snippet,
          status: 'POLICY_OK',
          textContentLen: art.textLen,
          textContentSource: 'dev-seed',
          usableForOverview: true,
        },
      });

      await prisma.eventArticle.create({
        data: { eventId: event.id, articleId: article.id },
      });
    }

    // Create a version with headline + minimal packet
    await prisma.eventVersion.create({
      data: {
        eventId: event.id,
        versionIndex: 0,
        headline: seed.headline,
        gateStatus: 'PASS',
        packetJson: {
          ai_overview: {
            what_happened: [`${seed.headline}.`],
            context: ['Evento creado por dev-seed para desarrollo local.'],
            in_dispute: [],
            confidence_label: 'Demo',
          },
          overview_mode: 'dev-seed',
          key_facts_count: 0,
        },
      },
    });

    seeded++;
  }

  logger.info({ seeded }, 'dev_seed_complete');
  return seeded;
}
