import { FastifyInstance } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { Cache } from '../../core/cache/cache.js';

const TOPIC_LABELS: Record<string, string> = {
  SEGURIDAD: 'Seguridad',
  ECONOMIA: 'Economía',
  JUSTICIA: 'Justicia',
  SALUD: 'Salud',
  EDUCACION: 'Educación',
  CORRUPCION: 'Corrupción',
  PROTESTA: 'Protesta',
  POLITICA: 'Política',
  RELACIONES_INT: 'Relaciones Internacionales',
  AMBIENTE: 'Ambiente',
  TECNOLOGIA: 'Tecnología',
  INFRAESTRUCTURA: 'Infraestructura',
  OTROS: 'Otros',
};

export function topicsRoutes(prisma: PrismaClient, cache?: Cache) {
  return async function (app: FastifyInstance) {
    app.get('/v1/topics', async (_request, reply) => {
      const cacheKey = 'topics:list';

      if (cache) {
        const cached = cache.get(cacheKey);
        if (cached !== undefined) return cached;
      }

      // Count distinct published events per topic
      const rows = await prisma.$queryRaw<Array<{ topic_key: string; event_count: bigint }>>`
        SELECT ta.topic_key, COUNT(DISTINCT ta.event_id) AS event_count
        FROM topic_assignment ta
        JOIN event e ON e.id = ta.event_id
        WHERE e.state = 'PUBLISHED'
          AND e.canonical_event_id IS NULL
        GROUP BY ta.topic_key
        ORDER BY event_count DESC
      `;

      const items = rows.map((r) => ({
        topic_key: r.topic_key,
        label: TOPIC_LABELS[r.topic_key] ?? r.topic_key,
        event_count: Number(r.event_count),
      }));

      const body = { items };

      if (cache) {
        cache.set(cacheKey, body, 30_000);
      }

      reply.header('cache-control', 'public, max-age=30');
      return body;
    });
  };
}
