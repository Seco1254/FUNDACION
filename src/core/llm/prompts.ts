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
    `[${i + 1}] media: ${a.media_key} | url: ${a.url}\n    title: ${a.title}\n    snippet: ${a.snippet}`,
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

  return `Genera un resumen periodístico estructurado basado EXCLUSIVAMENTE en la siguiente evidencia.

CONSENSO ENTRE FUENTES:
${consensusList}

PUNTOS EN DISPUTA:
${disputeList}

CITAS CLAVE (${input.sources_count} fuentes, ${input.claims_count} claims):
${quoteList}

REGLAS ESTRICTAS:
- NO inventes información que no esté en la evidencia.
- Si la evidencia es insuficiente, di "No concluyente" y explica por qué.
- Cada bullet debe estar respaldado por al menos una cita.
- overview: 3-5 frases resumen (párrafo completo, no telegráfico).
- what_happened: 3-5 bullets de hechos verificados. Cada bullet debe ser una oración completa con contexto.
- context: 3-5 bullets de contexto/antecedentes relevantes.
- in_dispute: 2-4 bullets de puntos en disputa (si los hay).
- Total mínimo: ~150 palabras entre todas las secciones. NO seas escueto.

Responde EXCLUSIVAMENTE con JSON válido:`;
}

export const OVERVIEW_SYSTEM = `Eres un editor de noticias colombiano senior. Generas resúmenes precisos y equilibrados basados SOLO en evidencia proporcionada.
NUNCA inventes hechos, nombres o cifras que no estén en la entrada.
Si la evidencia es insuficiente para una sección, usa: "Sin evidencia suficiente aún."
Responde SOLO con JSON válido. No incluyas texto fuera del JSON.

Schema esperado:
{
  "overview": "string (3-5 frases resumen, párrafo completo)",
  "what_happened": ["bullet 1", "bullet 2", "bullet 3"],
  "context": ["bullet 1", "bullet 2", "bullet 3"],
  "in_dispute": ["bullet 1", "bullet 2"],
  "confidence_label": "Alta|Media|Baja|No concluyente",
  "why": "string (1-2 frases explicando confianza y cobertura)"
}`;
