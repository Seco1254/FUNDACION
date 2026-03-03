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

// ── Colombia-specific high-confidence keywords ──────────────────
// Presence of these yields a +0.15 boost per hit (capped).
const COLOMBIA_BOOST_KEYWORDS: Record<string, string[]> = {
  POLITICA: [
    'registraduría', 'fiscal general', 'corte constitucional', 'corte suprema',
    'procuraduría', 'contraloría', 'ministerio', 'cámara de representantes',
    'consejo de estado', 'jep',
  ],
  CRIMEN_SEGURIDAD: [
    'disidencias', 'eln', 'bacrim', 'explosivos', 'minas antipersona',
    'desmovilizado', 'extradición', 'dea', 'incautación', 'cartel',
  ],
  ECONOMIA: [
    'banrep', 'banco de la república', 'tasa de interés', 'dane',
    'tasa de cambio', 'superfinanciera', 'dian', 'iva',
  ],
  DEPORTES: [
    'liga betplay', 'liga colombiana', 'primera a', 'dimayor',
    'millonarios', 'atlético nacional', 'atletico nacional', 'club nacional',
    'américa de cali', 'junior', 'santa fe', 'cali',
    'selección colombia', 'seleccion colombia', 'fifa', 'conmebol',
  ],
  SALUD: [
    'eps', 'minsalud', 'supersalud', 'invima', 'sisben', 'ips',
  ],
  MEDIO_AMBIENTE: [
    'ideam', 'anla', 'parques nacionales', 'car', 'amazonia',
    'pacífico', 'corponariño', 'corpoboyacá',
  ],
};

// ── Desk-to-topic mapping for desk boost ─────────────────────────
const DESK_TOPIC_MAP: Record<string, string> = {
  POLITICA: 'POLITICA',
  ECONOMIA: 'ECONOMIA',
  DEPORTES: 'DEPORTES',
  SALUD: 'SALUD',
  MEDIO_AMBIENTE: 'MEDIO_AMBIENTE',
  OPINION: 'OPINION',
  CRIMEN: 'CRIMEN_SEGURIDAD',
  BOGOTA: 'POLITICA',
  COLOMBIA: 'POLITICA',
  MUNDO: 'POLITICA',
  ENTRETENIMIENTO: 'ENTRETENIMIENTO',
  TECNOLOGIA: 'ECONOMIA',
};

const DESK_BOOST = 0.20;
const COLOMBIA_KEYWORD_BOOST = 0.15;

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

// ── Lightweight desk extraction for topic boost (avoids cross-module dep) ──

const DESK_HINTS: Record<string, string> = {
  'politica': 'POLITICA', 'gobierno': 'POLITICA',
  'economia': 'ECONOMIA', 'finanzas': 'ECONOMIA', 'negocios': 'ECONOMIA',
  'deportes': 'DEPORTES', 'deporte': 'DEPORTES', 'futbol': 'DEPORTES',
  'salud': 'SALUD', 'vida': 'SALUD',
  'seguridad': 'CRIMEN', 'justicia': 'CRIMEN', 'judicial': 'CRIMEN',
  'crimen': 'CRIMEN', 'unidad-investigativa': 'CRIMEN',
  'bogota': 'BOGOTA', 'colombia': 'COLOMBIA',
  'mundo': 'MUNDO', 'internacional': 'MUNDO',
  'medio-ambiente': 'MEDIO_AMBIENTE', 'ambiente': 'MEDIO_AMBIENTE',
  'entretenimiento': 'ENTRETENIMIENTO', 'cultura': 'ENTRETENIMIENTO',
  'opinion': 'OPINION', 'columnistas': 'OPINION',
};

function extractDeskForTopic(url: string): string | null {
  try {
    const path = new URL(url).pathname.toLowerCase();
    for (const seg of path.split('/').filter(Boolean)) {
      const desk = DESK_HINTS[seg];
      if (desk) return desk;
    }
    return null;
  } catch {
    return null;
  }
}

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

  // 4. Desk boost: if URL yields a desk, boost the corresponding topic
  if (input.url) {
    const desk = extractDeskForTopic(input.url);
    if (desk) {
      const topicForDesk = DESK_TOPIC_MAP[desk];
      if (topicForDesk) {
        scores.set(topicForDesk, (scores.get(topicForDesk) ?? 0) + DESK_BOOST);
        reasons.push(`DESK_BOOST:${desk}→${topicForDesk}`);
      }
    }
  }

  // 5. Colombia-specific high-confidence keywords
  for (const [topic, keywords] of Object.entries(COLOMBIA_BOOST_KEYWORDS)) {
    for (const kw of keywords) {
      const kwNorm = normalize(kw);
      if (text.includes(kwNorm)) {
        scores.set(topic, (scores.get(topic) ?? 0) + COLOMBIA_KEYWORD_BOOST);
        reasons.push(`CO_KW:${kw}→${topic}`);
        break; // one boost per topic from Colombia keywords
      }
    }
  }

  // Pick the best topic
  const sorted = Array.from(scores.entries())
    .filter(([, w]) => w > 0)
    .sort((a, b) => b[1] - a[1]);

  if (sorted.length > 0) {
    const [topKey, topWeight] = sorted[0];
    // Confidence adjustment: if 2nd-place is close, lower confidence
    const runnerUp = sorted.length > 1 ? sorted[1][1] : 0;
    const gap = topWeight - runnerUp;
    let score = Math.min(topWeight, 1.0);
    if (gap < 0.05 && sorted.length > 1) {
      // Close race — lower confidence
      score = Math.min(score, 0.45);
      reasons.push('CLOSE_RACE');
    }
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

// ── Event-level topic aggregator ─────────────────────────────────

export interface ArticleTopicVote {
  topic_key: string;
  score: number;
  article_index: number;
}

export interface EventTopicResult {
  topic_key: string;
  topic_confidence: number;  // 0..1
  votes: ArticleTopicVote[];
  reasons: string[];
  /** Top signals that drove the classification (max 5), for observability. */
  topic_signals?: string[];
  /** Short human-readable explanation of the classification. */
  topic_reason?: string;
}

export interface EventArticleInput {
  title?: string | null;
  url?: string | null;
  contentType?: string | null;
}

const MAX_SAMPLE = 5;

/**
 * Deterministic sampling of up to MAX_SAMPLE articles spread evenly.
 * Returns indices into the original array.
 */
function sampleIndices(length: number): number[] {
  if (length <= MAX_SAMPLE) return Array.from({ length }, (_, i) => i);
  // Spread evenly: first, 1/4, 1/2, 3/4, last
  const last = length - 1;
  return [
    0,
    Math.floor(last / 4),
    Math.floor(last / 2),
    Math.floor((3 * last) / 4),
    last,
  ];
}

/**
 * Aggregate topic across multiple articles in an event.
 *
 * Each sampled article (up to 5) casts a weighted vote via classifyTopic.
 * The headline + overviewText get a bonus-weighted vote (1.5x) to anchor
 * the classification. Final topic = weighted mode across all votes.
 *
 * topic_confidence = winner_weight / total_weight, clamped to 0..1.
 */
export function aggregateEventTopic(
  headline: string | null,
  articles: EventArticleInput[],
  overviewText?: string | null,
): EventTopicResult {
  const votes: ArticleTopicVote[] = [];
  const topicWeights = new Map<string, number>();
  const reasons: string[] = [];

  // Headline + overview vote (anchor, weight 1.5)
  const headlineResult = classifyTopic({
    title: headline,
    text: overviewText ?? null,
    url: articles[0]?.url ?? null,
  });
  const headlineWeight = headlineResult.score * 1.5;
  topicWeights.set(headlineResult.topic_key, headlineWeight);
  reasons.push(`HEADLINE_VOTE:${headlineResult.topic_key}(${headlineResult.score})`);

  // Sample articles for voting
  const indices = sampleIndices(articles.length);

  for (const idx of indices) {
    const art = articles[idx];
    const result = classifyTopic({
      title: art.title,
      url: art.url,
      contentType: art.contentType,
    });
    votes.push({ topic_key: result.topic_key, score: result.score, article_index: idx });
    topicWeights.set(
      result.topic_key,
      (topicWeights.get(result.topic_key) ?? 0) + result.score,
    );
  }

  // Pick winner by weighted votes
  const totalWeight = Array.from(topicWeights.values()).reduce((a, b) => a + b, 0);
  const sorted = Array.from(topicWeights.entries()).sort((a, b) => {
    // Primary: weight descending. Secondary: alphabetical for determinism.
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });

  const [winnerKey, winnerWeight] = sorted[0] ?? ['OTROS', 0];
  const confidence = totalWeight > 0
    ? Math.round((winnerWeight / totalWeight) * 1000) / 1000
    : 0;

  reasons.push(`WINNER:${winnerKey}(${winnerWeight.toFixed(3)}/${totalWeight.toFixed(3)})`);

  // Build topic_signals: collect unique signal types from headline + article reasons
  const allSignals: string[] = [];
  for (const r of headlineResult.reasons) {
    if (r.startsWith('DESK_BOOST:') || r.startsWith('CO_KW:') || r.startsWith('URL_SECTION:') || r.startsWith('CONTENT_TYPE:')) {
      allSignals.push(r);
    }
  }
  // Also scan for keyword-based signals
  if (headlineResult.reasons.some((r) => r.startsWith('KEYWORD_MATCH:'))) {
    allSignals.push(`kw:headline→${headlineResult.topic_key}`);
  }
  for (const v of votes) {
    allSignals.push(`kw:art${v.article_index}→${v.topic_key}`);
  }
  const topicSignals = [...new Set(allSignals)].slice(0, 5);

  // topic_reason
  const confLabel = confidence >= 0.7 ? 'high' : confidence >= 0.5 ? 'medium' : 'low';
  const topicReason = `${winnerKey} conf=${confidence} (${confLabel}), ${votes.length} votes`;

  return {
    topic_key: winnerKey,
    topic_confidence: Math.min(confidence, 1),
    votes,
    reasons,
    topic_signals: topicSignals,
    topic_reason: topicReason,
  };
}

/** All valid topic keys for feed filtering. */
export const ALL_TOPIC_KEYS = [
  'POLITICA', 'CRIMEN_SEGURIDAD', 'DEPORTES', 'ECONOMIA',
  'SALUD', 'MEDIO_AMBIENTE', 'ENTRETENIMIENTO', 'OPINION', 'OTROS',
] as const;

export type TopicKey = typeof ALL_TOPIC_KEYS[number];
