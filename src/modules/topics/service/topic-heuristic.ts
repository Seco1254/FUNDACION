/**
 * Heuristic Topic Classifier — deterministic, no LLM.
 *
 * Guarantees topics.top1 is never null for any article/event with text.
 * Uses keyword matching, URL path hints, and title patterns.
 *
 * Extends the existing keyword-based scorer with:
 *   - DEPORTES, ENTRETENIMIENTO, OPINION categories (not in v0_1 taxonomy)
 *   - URL section heuristics (e.g. /deportes/ → DEPORTES)
 *   - Lower threshold (any match counts, not 20% weight)
 *   - Fallback to OTROS only when nothing matches
 *
 * The existing TopicAssigner (topics_keywords_v0_1.json) is kept intact.
 * This module is used as a FALLBACK when that scorer returns OTROS or is
 * not yet run (e.g. during ingestion, before OverviewGenerated).
 */

export interface HeuristicTopicResult {
  topic_key: string;
  score: number;       // 0..1
  reasons: string[];
}

export interface HeuristicTopicInput {
  text?: string | null;
  title?: string | null;
  url?: string | null;
  contentType?: string | null; // from content-classifier: 'opinion'|'news'|etc
}

// ── Keyword dictionaries ────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  POLITICA: [
    'gobierno', 'presidente', 'congreso', 'senado', 'cámara', 'partido',
    'elección', 'elecciones', 'candidato', 'votación', 'ministro',
    'gobernador', 'alcalde', 'reforma', 'oposición', 'coalición',
    'parlamento', 'decreto', 'constitución', 'petro', 'duque',
    'legislatura', 'gabinete', 'demócrata', 'republicano',
  ],
  CRIMEN_SEGURIDAD: [
    'sicario', 'sicarios', 'asesinado', 'asesinato', 'capturado', 'captura',
    'fiscalía', 'homicidio', 'homicidios', 'crimen', 'criminal',
    'narcotráfico', 'narco', 'secuestro', 'extorsión', 'policía',
    'ejército', 'guerrilla', 'violencia', 'masacre', 'atentado',
    'balacera', 'robo', 'hurto', 'atraco', 'delincuencia',
    'pandilla', 'banda', 'cárcel', 'prisión', 'condena', 'imputado',
    'investigación penal', 'fiscalía', 'juicio', 'tribunal', 'sentencia',
    'arma', 'disparo', 'herido', 'muerto', 'víctima',
    'desaparecido', 'fosa', 'cadáver',
  ],
  DEPORTES: [
    'fútbol', 'futbol', 'gol', 'goles', 'selección', 'mundial',
    'liga', 'torneo', 'campeonato', 'copa', 'partido de', 'estadio',
    'jugador', 'jugadores', 'entrenador', 'técnico', 'equipo',
    'deporte', 'deportes', 'deportivo', 'deportiva',
    'basketball', 'baloncesto', 'tenis', 'ciclismo', 'ciclista',
    'natación', 'atletismo', 'boxeo', 'béisbol', 'olímpico',
    'olímpicos', 'medalla', 'campeón', 'subcampeón', 'final',
    'semifinal', 'eliminatoria', 'clasificación', 'fichaje',
    'transferencia', 'lesión', 'arbitro', 'goleador', 'asistencia',
    'penal', 'penalti', 'tarjeta roja', 'empate', 'victoria', 'derrota',
    'nba', 'nfl', 'uefa', 'conmebol', 'fifa', 'f1', 'formula 1',
  ],
  ECONOMIA: [
    'economía', 'económico', 'económica', 'pib', 'inflación',
    'dólar', 'peso', 'impuesto', 'tributaria', 'fiscal',
    'presupuesto', 'deuda', 'banco', 'financiero', 'empleo',
    'desempleo', 'inversión', 'mercado', 'exportación', 'importación',
    'salario', 'precio', 'tasa de interés', 'bolsa', 'acciones',
    'crecimiento', 'recesión', 'comercio',
  ],
  SALUD: [
    'salud', 'hospital', 'médico', 'pandemia', 'vacuna',
    'enfermedad', 'paciente', 'clínica', 'epidemia', 'virus',
    'contagio', 'mortalidad', 'farmacia', 'medicamento', 'sanitario',
    'eps', 'seguro médico', 'cirugía', 'tratamiento', 'diagnóstico',
  ],
  MEDIO_AMBIENTE: [
    'ambiente', 'ambiental', 'clima', 'climático', 'deforestación',
    'contaminación', 'biodiversidad', 'ecología', 'sostenible',
    'carbono', 'minería', 'petróleo', 'energía', 'renovable',
    'calentamiento', 'sequía', 'inundación', 'huracán',
    'terremoto', 'sismo', 'reciclaje', 'emisiones',
  ],
  ENTRETENIMIENTO: [
    'entretenimiento', 'celebrity', 'celebridad', 'famoso', 'famosa',
    'farándula', 'espectáculo', 'show', 'concierto', 'película',
    'serie', 'televisión', 'actor', 'actriz', 'cantante',
    'música', 'álbum', 'estreno', 'festival', 'premio',
    'netflix', 'disney', 'hollywood', 'telenovela', 'reality',
    'influencer', 'viral', 'tendencia', 'moda', 'redes sociales',
  ],
  OPINION: [
    'columna', 'columnista', 'editorial', 'opinión', 'análisis',
    'comentario', 'punto de vista', 'reflexión', 'perspectiva',
    'tribuna', 'carta abierta',
  ],
};

// ── URL section hints (path segment → topic bonus) ──────────────

const URL_SECTION_HINTS: Record<string, string> = {
  'politica': 'POLITICA',
  'gobierno': 'POLITICA',
  'justicia': 'CRIMEN_SEGURIDAD',
  'judicial': 'CRIMEN_SEGURIDAD',
  'seguridad': 'CRIMEN_SEGURIDAD',
  'crimen': 'CRIMEN_SEGURIDAD',
  'deportes': 'DEPORTES',
  'deporte': 'DEPORTES',
  'futbol': 'DEPORTES',
  'economia': 'ECONOMIA',
  'finanzas': 'ECONOMIA',
  'negocios': 'ECONOMIA',
  'salud': 'SALUD',
  'medio-ambiente': 'MEDIO_AMBIENTE',
  'ambiente': 'MEDIO_AMBIENTE',
  'entretenimiento': 'ENTRETENIMIENTO',
  'cultura': 'ENTRETENIMIENTO',
  'gente': 'ENTRETENIMIENTO',
  'opinion': 'OPINION',
  'columnistas': 'OPINION',
};

// ── Normalizer ─────────────────────────────────────────────────

/** Normalize text for matching: lowercase, strip accents. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

// ── Core classifier ─────────────────────────────────────────────

/**
 * Classify article/event text into a topic using keyword heuristics.
 * Always returns a result (never null). Falls back to OTROS.
 */
export function classifyTopic(input: HeuristicTopicInput): HeuristicTopicResult {
  const textRaw = [input.title ?? '', input.text ?? ''].join('. ');
  const text = normalize(textRaw);
  const tokens = text.split(/\s+/);
  const totalTokens = Math.max(tokens.length, 1);

  const scores = new Map<string, number>();
  const reasons: string[] = [];

  // 1. Keyword matching
  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let matchCount = 0;
    for (const kw of keywords) {
      const kwNorm = normalize(kw);
      // For multi-word keywords, check substring in full text
      if (kwNorm.includes(' ')) {
        if (text.includes(kwNorm)) matchCount += 2;
      } else {
        // Single word: check token containment
        for (const token of tokens) {
          if (token.includes(kwNorm)) {
            matchCount++;
          }
        }
      }
    }

    if (matchCount > 0) {
      const weight = matchCount / totalTokens;
      scores.set(topic, (scores.get(topic) ?? 0) + weight);
    }
  }

  // 2. URL section hints (bonus: +0.15 for matching URL section)
  if (input.url) {
    try {
      const path = new URL(input.url).pathname.toLowerCase();
      const segments = path.split('/').filter(Boolean);
      for (const seg of segments) {
        const hint = URL_SECTION_HINTS[seg];
        if (hint) {
          scores.set(hint, (scores.get(hint) ?? 0) + 0.15);
          reasons.push(`URL_SECTION:${seg}→${hint}`);
        }
      }
    } catch {
      // Invalid URL, skip
    }
  }

  // 3. Content-type hint: opinion from content-classifier
  if (input.contentType === 'opinion') {
    scores.set('OPINION', (scores.get('OPINION') ?? 0) + 0.20);
    reasons.push('CONTENT_TYPE:opinion');
  }

  // Pick the best topic
  const sorted = Array.from(scores.entries())
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length > 0) {
    const [topKey, topWeight] = sorted[0];
    // Clamp score to 0..1
    const score = Math.min(topWeight, 1.0);
    reasons.push(`KEYWORD_MATCH:${topKey}`);
    return { topic_key: topKey, score: Math.round(score * 1000) / 1000, reasons };
  }

  return { topic_key: 'OTROS', score: 0.1, reasons: ['NO_KEYWORD_MATCH'] };
}

/**
 * Classify and return topic_keys array (for packet.topic_keys bridging).
 * Returns up to 2 topics sorted by score.
 */
export function classifyTopicKeys(input: HeuristicTopicInput): string[] {
  const textRaw = [input.title ?? '', input.text ?? ''].join('. ');
  const text = normalize(textRaw);
  const tokens = text.split(/\s+/);
  const totalTokens = Math.max(tokens.length, 1);

  const scores = new Map<string, number>();

  for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
    let matchCount = 0;
    for (const kw of keywords) {
      const kwNorm = normalize(kw);
      if (kwNorm.includes(' ')) {
        if (text.includes(kwNorm)) matchCount += 2;
      } else {
        for (const token of tokens) {
          if (token.includes(kwNorm)) matchCount++;
        }
      }
    }
    if (matchCount > 0) {
      scores.set(topic, matchCount / totalTokens);
    }
  }

  if (input.url) {
    try {
      const path = new URL(input.url).pathname.toLowerCase();
      const segments = path.split('/').filter(Boolean);
      for (const seg of segments) {
        const hint = URL_SECTION_HINTS[seg];
        if (hint) scores.set(hint, (scores.get(hint) ?? 0) + 0.15);
      }
    } catch { /* skip */ }
  }

  if (input.contentType === 'opinion') {
    scores.set('OPINION', (scores.get('OPINION') ?? 0) + 0.20);
  }

  const sorted = Array.from(scores.entries())
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([k]) => k);

  return sorted.length > 0 ? sorted : ['OTROS'];
}

/** All valid topic keys for feed filtering. */
export const ALL_TOPIC_KEYS = [
  'POLITICA', 'CRIMEN_SEGURIDAD', 'DEPORTES', 'ECONOMIA',
  'SALUD', 'MEDIO_AMBIENTE', 'ENTRETENIMIENTO', 'OPINION', 'OTROS',
] as const;

export type TopicKey = typeof ALL_TOPIC_KEYS[number];
