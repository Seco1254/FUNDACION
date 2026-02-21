/**
 * LLM prompt templates for Semantic Intelligence v2.
 * All prompts enforce: no fabrication, evidence-only, structured JSON output.
 */

export interface ArticleInput {
  article_id: string;
  media_key: string;
  title: string;
  snippet: string;
  url: string;
  published_at: string | null;
}

// ── CLAIM EXTRACTION ────────────────────────────────────────────────

export function buildClaimExtractionPrompt(articles: ArticleInput[]): string {
  const articleList = articles.map((a, i) =>
    `[${i + 1}] media: ${a.media_key} | url: ${a.url}\n    title: ${a.title}\n    texto: ${a.snippet}`,
  ).join('\n\n');

  return `Analiza los siguientes artículos de noticias colombianas y extrae claims (afirmaciones atómicas verificables).

ARTÍCULOS:
${articleList}

REGLAS ESTRICTAS:
- Solo extraer claims que estén explícitamente en los artículos. NO inventar.
- Cada claim debe tener al menos una evidencia (quote textual del artículo).
- confidence entre 0.0 y 1.0 basada en cuántas fuentes lo respaldan.
- polarity: "affirm" si afirma, "deny" si niega, "unclear" si ambiguo.
- claim_type: "FACT", "QUANT", "ALLEGATION", "FORECAST", o "OPINION".
- Máximo 15 claims. Priorizar los más importantes.

Responde EXCLUSIVAMENTE con JSON válido:`;
}

export const CLAIM_EXTRACTION_SCHEMA = `{
  "claims": [
    {
      "claim_text": "string (afirmación concisa en español)",
      "claim_type": "FACT|QUANT|ALLEGATION|FORECAST|OPINION",
      "subject": "string (quién/qué)",
      "predicate": "string (acción/verbo)",
      "object": "string (complemento)",
      "polarity": "affirm|deny|unclear",
      "confidence": 0.0,
      "evidence": [
        {
          "source_url": "string (url del artículo)",
          "quote": "string (cita textual del artículo, máx 200 chars)",
          "span_hint": "string (fragmento para ubicar la cita)"
        }
      ]
    }
  ]
}`;

export const CLAIM_EXTRACTION_SYSTEM = `Eres un analista de noticias colombiano experto. Tu trabajo es extraer claims verificables de artículos periodísticos.
NUNCA inventes información. Solo usa lo que está explícitamente en los artículos proporcionados.
Responde SOLO con JSON válido siguiendo el schema indicado. No incluyas texto adicional fuera del JSON.

Schema esperado:
${CLAIM_EXTRACTION_SCHEMA}`;

// ── DISPUTE DETECTION ───────────────────────────────────────────────

export interface ClaimInput {
  claim_id: string;
  claim_text: string;
  claim_type: string;
  source_urls: string[];
  media_keys: string[];
  top_quote: string;
}

export function buildDisputeDetectionPrompt(claims: ClaimInput[]): string {
  const claimList = claims.map((c, i) =>
    `[${i + 1}] id: ${c.claim_id} | type: ${c.claim_type}\n` +
    `    text: ${c.claim_text}\n` +
    `    fuentes: ${c.media_keys.join(', ')}\n` +
    `    cita: "${c.top_quote}"`,
  ).join('\n\n');

  return `Analiza los siguientes claims extraídos de múltiples medios colombianos e identifica:
1. DISPUTAS: claims que se contradicen entre sí (diferentes medios dicen cosas opuestas).
2. CONSENSO: claims en los que hay acuerdo entre medios.

CLAIMS:
${claimList}

REGLAS:
- Solo reportar disputas REALES (contradicción clara, no diferencias de matiz).
- Incluir fuentes específicas en cada disputa/consenso.
- confidence entre 0.0 y 1.0.
- Si hay menos de 2 fuentes distintas: disputes debe ser vacío.

Responde EXCLUSIVAMENTE con JSON válido:`;
}

export const DISPUTE_DETECTION_SYSTEM = `Eres un analista de noticias especializado en detectar contradicciones entre fuentes periodísticas colombianas.
NUNCA inventes disputas. Solo reporta contradicciones que sean claras y estén respaldadas por los claims proporcionados.
Responde SOLO con JSON válido. No incluyas texto fuera del JSON.

Schema esperado:
{
  "disputes": [
    {
      "topic": "string (tema de la disputa)",
      "point_a": { "claim_text": "string", "source_url": "string" },
      "point_b": { "claim_text": "string", "source_url": "string" },
      "why_disputed": "string (explicación breve)",
      "confidence": 0.0
    }
  ],
  "consensus": [
    {
      "claim_text": "string",
      "why_consensus": "string",
      "confidence": 0.0,
      "evidence": [{ "source_url": "string", "quote": "string" }]
    }
  ]
}`;

// ── AI OVERVIEW ─────────────────────────────────────────────────────

export interface OverviewInput {
  consensus: Array<{ claim_text: string; why_consensus: string; confidence: number }>;
  disputes: Array<{ topic: string; why_disputed: string; confidence: number }>;
  top_quotes: Array<{ quote: string; media_key: string; url: string }>;
  claims_count: number;
  sources_count: number;
}

export function buildOverviewPrompt(input: OverviewInput): string {
  const consensusList = input.consensus.length > 0
    ? input.consensus.map((c, i) => `  ${i + 1}. ${c.claim_text} (conf: ${c.confidence.toFixed(2)})`).join('\n')
    : '  (sin consenso claro)';

  const disputeList = input.disputes.length > 0
    ? input.disputes.map((d, i) => `  ${i + 1}. ${d.topic}: ${d.why_disputed} (conf: ${d.confidence.toFixed(2)})`).join('\n')
    : '  (sin disputas detectadas)';

  const quoteList = input.top_quotes.slice(0, 10).map((q, i) =>
    `  ${i + 1}. [${q.media_key}] "${q.quote}"`,
  ).join('\n');

  const singleSourceNote = input.sources_count < 2
    ? '\n- NOTA: Solo hay UNA fuente. Incluye en "why" la frase: "Evidencia limitada (una fuente)."'
    : '';

  return `Genera un resumen periodístico estructurado basado EXCLUSIVAMENTE en la siguiente evidencia.

CONSENSO ENTRE FUENTES:
${consensusList}

PUNTOS EN DISPUTA:
${disputeList}

CITAS CLAVE (${input.sources_count} fuentes, ${input.claims_count} claims):
${quoteList}

REGLAS ESTRICTAS:
- NO inventes información que no esté en la evidencia.
- NUNCA dejes una sección vacía con "Sin información disponible" si hay citas proporcionadas.
- Si la evidencia para una sección específica es insuficiente, reformula usando la información disponible.
- Cada bullet debe estar respaldado por al menos una cita y ser una oración completa con contexto.
- overview: 3-5 frases resumen (párrafo completo, no telegráfico).
- what_happened: 3-5 bullets de hechos verificados.
- context: 3-5 bullets de contexto/antecedentes relevantes.
- in_dispute: 2-4 bullets de puntos en disputa. Si no hay disputa: ["No se identifican versiones contradictorias por ahora."]
- Total mínimo: 150-220 palabras entre todas las secciones. NO seas escueto.
- facts_extracted: 5-10 fragmentos clave extraídos de las citas (para auditoría interna, no se muestran al usuario).${singleSourceNote}

Responde EXCLUSIVAMENTE con JSON válido:`;
}

export const OVERVIEW_SYSTEM = `Eres un editor de noticias colombiano senior. Generas resúmenes precisos y equilibrados basados SOLO en evidencia proporcionada.
NUNCA inventes hechos, nombres o cifras que no estén en la entrada.
NUNCA respondas "Sin información disponible" si se proporcionaron citas. Reformula con lo que hay.
Si solo hay una fuente, incluye: "Evidencia limitada (una fuente)." en el campo "why".
Responde SOLO con JSON válido. No incluyas texto fuera del JSON.

Schema esperado:
{
  "overview": "string (3-5 frases resumen, párrafo completo, ~80 palabras)",
  "what_happened": ["bullet 1", "bullet 2", "bullet 3", "...hasta 5"],
  "context": ["bullet 1", "bullet 2", "bullet 3", "...hasta 5"],
  "in_dispute": ["bullet 1", "bullet 2"],
  "confidence_label": "Alta|Media|Baja|No concluyente",
  "why": "string (1-2 frases explicando confianza y cobertura)",
  "facts_extracted": ["fragmento clave 1", "fragmento clave 2", "...hasta 10"]
}`;

// ── OVERVIEW WRITER (v3 — facts-based single LLM call) ─────────────

import type { FactsPacket } from './facts-extractor.js';

export function buildOverviewWriterPrompt(facts: FactsPacket): string {
  // Format facts with multi-source attribution for consensus/disagreement detection
  const factsList = facts.key_facts.map((f, i) => {
    const sourceLabel = f.sources.length > 1
      ? `[${f.sources.join(', ')}]`
      : `[${f.source_id}]`;
    const quote = f.context_sentence ?? f.quote;
    return `  ${i + 1}. ${f.text}${quote ? ` — "${quote}"` : ''} ${sourceLabel}`;
  }).join('\n');

  const conflictsList = facts.conflicts.length > 0
    ? facts.conflicts.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '  (sin conflictos detectados)';

  const uncertaintiesList = facts.uncertainties.length > 0
    ? facts.uncertainties.map((u, i) => `  ${i + 1}. ${u}`).join('\n')
    : '  (sin incertidumbres)';

  const sourceNames = facts.coverage_summary.source_names.join(', ');
  const isSingleSource = facts.coverage_summary.sources_count < 2;

  const singleSourceNote = isSingleSource
    ? `\n- IMPORTANTE: Solo hay UNA fuente (${sourceNames}). DEBES incluir en "why": "Nota: información de una única fuente y no ha sido contrastada con medios independientes." En analisis_fuentes.informacion_faltante incluye: "Solo se cuenta con una fuente; se requiere contraste independiente."`
    : '';

  // Mixed topic warning (injected by overview-generator when tripwire detects it)
  const mixedTopicWarning = (facts as any).mixed_topic_flag
    ? `\n\nADVERTENCIA: Los artículos de este evento parecen cubrir temas distintos. Si confirmas que los temas son diferentes, indica esto explícitamente en el resumen y en analisis_fuentes.informacion_faltante.`
    : '';

  return `Genera un resumen periodístico editorial basado EXCLUSIVAMENTE en los siguientes hechos verificados. Escribe como un editor de noticias profesional, NO como un agregador RSS.

TÍTULO: ${facts.canonical_title}

HECHOS VERIFICADOS (${facts.key_facts.length} hechos de ${facts.coverage_summary.sources_count} fuentes):
${factsList}

PUNTOS EN CONFLICTO:
${conflictsList}

INCERTIDUMBRES:
${uncertaintiesList}

COBERTURA: ${facts.coverage_summary.articles_used} artículos, ${facts.coverage_summary.total_text_len} caracteres de texto.${mixedTopicWarning}

INSTRUCCIONES DE REDACCIÓN:
- overview: Párrafo narrativo de 120-180 palabras. Estructura: apertura contextual → desarrollo de hechos clave → cierre con perspectiva. Cada oración debe conectar con la anterior. NO uses listas ni bullets en este campo.
- what_happened: 3-5 oraciones COMPLETAS (mínimo 15 palabras cada una) que narren la secuencia de hechos con sujeto-verbo-complemento y atribución a fuente (ej: "Según El Tiempo, el gobierno anunció...").
- context: 3-5 oraciones completas de antecedentes necesarios para entender la noticia, redactadas como texto conectado.
- in_dispute: 2-4 oraciones que identifiquen en qué coinciden los medios, en qué difieren, y qué información falta. Si todos coinciden, describe el consenso.

ANÁLISIS DE FUENTES (OBLIGATORIO):
- Identifica qué hechos reportan MÚLTIPLES medios (consenso) y cuáles solo UNO (no verificado).
- Para desacuerdos, menciona ambas posiciones con atribución al medio.

REGLAS ESTRICTAS:
- NO inventes información que no esté en los hechos verificados.
- NUNCA escribas "Sin información disponible". Si la evidencia es escasa, explica qué falta.
- NUNCA produzcas frases telegráficas. Cada bullet debe ser una oración completa de mínimo 15 palabras con contexto y atribución.
- Total entre TODAS las secciones: 250-350 palabras. NO seas escueto.
- fuentes: SIEMPRE incluye "Fuentes: ${sourceNames}".${singleSourceNote}

Responde EXCLUSIVAMENTE con JSON válido:`;
}

export const OVERVIEW_WRITER_SYSTEM = `Eres un editor de noticias colombiano senior. Tu rol es escribir resúmenes periodísticos narrativos, precisos y equilibrados. Escribes como un profesional de medios, no como un bot.

REGLAS INQUEBRANTABLES:
1. NUNCA inventes hechos, nombres o cifras que no estén en los hechos verificados proporcionados.
2. NUNCA escribas "Sin información disponible" ni "Aún no hay resumen" sin explicar por qué.
3. NUNCA produzcas listas telegráficas. Cada bullet es una oración completa de mínimo 15 palabras con contexto y atribución a fuente.
4. Si solo hay una fuente, incluye disclaimer explícito en "why".
5. SIEMPRE incluye "Fuentes: X, Y, Z" en "fuentes" citando los medios por nombre.
6. El resumen total debe tener entre 250 y 350 palabras.
7. El campo "overview" debe ser un párrafo narrativo editorial de 120-180 palabras, NO una lista.
8. Identifica explícitamente consenso y desacuerdo entre fuentes en analisis_fuentes.

Responde SOLO con JSON válido. No incluyas texto fuera del JSON.

Schema esperado:
{
  "overview": "string (párrafo narrativo editorial de 120-180 palabras, texto corrido sin bullets)",
  "what_happened": ["oración completa 1 (mín 15 palabras)", "oración completa 2", "...hasta 5"],
  "context": ["oración completa 1 (mín 15 palabras)", "oración completa 2", "...hasta 5"],
  "in_dispute": ["oración completa 1", "oración completa 2", "...hasta 4"],
  "analisis_fuentes": {
    "consenso": ["Todos los medios coinciden en que... (nombre de medios)"],
    "desacuerdo": ["Mientras X reporta..., Y señala que... (o vacío si no hay)"],
    "informacion_faltante": ["No se ha confirmado... / Solo una fuente reporta..."]
  },
  "confidence_label": "Alta|Media|Baja|No concluyente",
  "why": "string (1-2 frases explicando confianza + disclaimer si aplica)",
  "fuentes": "Fuentes: Medio 1, Medio 2, Medio 3"
}`;
