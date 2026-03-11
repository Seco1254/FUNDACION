/**
 * Pure heuristic facts extractor.
 * Derives a structured FactsPacket from existing claims+quotes+articles.
 * Zero LLM calls — all derivation is regex/pattern-based.
 */

export interface KeyFact {
  text: string;
  source_id: string;
  sources: string[];
  quote?: string;
  context_sentence?: string;
}

export interface FactsPacket {
  canonical_title: string;
  who: string[];
  what: string[];
  when: string[];
  where: string[];
  key_facts: KeyFact[];
  uncertainties: string[];
  conflicts: string[];
  coverage_summary: {
    sources_count: number;
    source_names: string[];
    articles_used: number;
    total_text_len: number;
  };
}

interface ClaimWithQuotes {
  id: string;
  claimText: string;
  claimType: string;
  status: string;
  quotes?: Array<{
    quoteText: string;
    article?: {
      url?: string;
      media?: { mediaKey?: string; name?: string };
    };
  }>;
}

interface ArticleInput {
  title: string;
  textNorm: string | null;
  url: string;
  mediaKey: string;
  mediaName: string;
  textContentLen: number | null;
}

// ── Heuristic entity extraction ──────────────────────────────────────

const COLOMBIAN_CITIES = [
  'bogotá', 'medellín', 'cali', 'barranquilla', 'cartagena',
  'bucaramanga', 'pereira', 'manizales', 'santa marta', 'ibagué',
  'cúcuta', 'villavicencio', 'pasto', 'montería', 'neiva',
  'armenia', 'popayán', 'sincelejo', 'tunja', 'valledupar',
];

const DATE_RE = /\b\d{1,2}\s+de\s+(?:enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)(?:\s+de\s+\d{4})?\b/gi;
const YEAR_RE = /\b20[12]\d\b/g;
const PLACE_RE = /\ben\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)*)/g;
const PROPER_NOUN_RE = /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})\b/g;

// Common words that look like proper nouns but aren't
const STOP_WORDS = new Set([
  'El', 'La', 'Los', 'Las', 'Un', 'Una', 'Del', 'Al', 'En', 'Con',
  'Por', 'Para', 'Sin', 'Sobre', 'Entre', 'Hasta', 'Desde', 'Según',
  'No', 'Se', 'Es', 'Son', 'Fue', 'Hay', 'Más', 'Además', 'También',
  'Como', 'Pero', 'Donde', 'Que', 'Este', 'Esta', 'Estos', 'Estas',
  'Gobierno', 'Colombia', 'Ministerio', 'Congreso',
]);

function extractWho(text: string): string[] {
  const matches = text.match(PROPER_NOUN_RE) ?? [];
  const unique = new Set<string>();
  for (const m of matches) {
    const first = m.split(' ')[0];
    if (STOP_WORDS.has(first)) continue;
    if (m.length < 4) continue;
    unique.add(m);
  }
  return [...unique].slice(0, 5);
}

function extractWhen(text: string): string[] {
  const dates = text.match(DATE_RE) ?? [];
  const years = text.match(YEAR_RE) ?? [];
  const all = [...new Set([...dates, ...years])];
  return all.slice(0, 3);
}

function extractWhere(text: string): string[] {
  const places = new Set<string>();
  let match;
  const re = new RegExp(PLACE_RE.source, PLACE_RE.flags);
  while ((match = re.exec(text)) !== null) {
    places.add(match[1]);
  }
  const lower = text.toLowerCase();
  for (const city of COLOMBIAN_CITIES) {
    if (lower.includes(city)) {
      places.add(city.charAt(0).toUpperCase() + city.slice(1));
    }
  }
  return [...places].slice(0, 5);
}

function extractWhat(claims: ClaimWithQuotes[]): string[] {
  return claims
    .filter((c) => c.status === 'SUPPORTED' && (c.claimType === 'FACT' || c.claimType === 'QUANT'))
    .slice(0, 5)
    .map((c) => c.claimText);
}

// ── Main extractor ───────────────────────────────────────────────────

export function extractFacts(
  claimsWithQuotes: ClaimWithQuotes[],
  articles: ArticleInput[],
  headline: string | null,
): FactsPacket {
  const canonicalTitle = headline || articles[0]?.title || '';

  // Key facts: SUPPORTED or DISPUTED claims with at least 1 quote
  const keyFacts: KeyFact[] = [];
  for (const claim of claimsWithQuotes) {
    if (claim.status !== 'SUPPORTED' && claim.status !== 'DISPUTED') continue;
    const quotes = claim.quotes ?? [];
    if (quotes.length === 0) continue;

    const topQuote = quotes[0];
    const quoteText = topQuote.quoteText?.slice(0, 180);

    // Collect all distinct media sources for this claim
    const claimSources = [...new Set(
      quotes
        .map((q) => q.article?.media?.name ?? q.article?.media?.mediaKey)
        .filter(Boolean) as string[],
    )];

    // Extract the full sentence containing the quote for narrative context
    let contextSentence: string | undefined;
    if (quoteText && quoteText.length > 20) {
      // Find the sentence boundary around the quote
      const fullQuote = topQuote.quoteText ?? '';
      const sentences = fullQuote.split(/(?<=[.;:])\s+/).filter((s) => s.length >= 30);
      contextSentence = sentences[0]?.slice(0, 250);
    }

    keyFacts.push({
      text: claim.claimText,
      source_id: topQuote.article?.media?.mediaKey ?? 'unknown',
      sources: claimSources.length > 0 ? claimSources : ['unknown'],
      quote: quoteText,
      context_sentence: contextSentence,
    });
  }

  // Uncertainties: INSUFFICIENT claims
  const uncertainties = claimsWithQuotes
    .filter((c) => c.status === 'INSUFFICIENT')
    .map((c) => c.claimText);

  // Conflicts: DISPUTED claims → descriptive string
  const conflicts: string[] = [];
  const disputed = claimsWithQuotes.filter((c) => c.status === 'DISPUTED');
  for (const claim of disputed) {
    const quotes = claim.quotes ?? [];
    const mediaSources = [...new Set(quotes.map((q) => q.article?.media?.name ?? q.article?.media?.mediaKey ?? 'unknown'))];
    conflicts.push(
      `${claim.claimText} (versiones de: ${mediaSources.join(', ')})`,
    );
  }

  // Coverage summary
  const mediaKeys = new Set<string>();
  const mediaNames = new Set<string>();
  let totalTextLen = 0;
  for (const a of articles) {
    mediaKeys.add(a.mediaKey);
    mediaNames.add(a.mediaName || a.mediaKey);
    totalTextLen += a.textContentLen ?? 0;
  }

  // Entity extraction from all claim texts + title
  const allText = [canonicalTitle, ...claimsWithQuotes.map((c) => c.claimText)].join('. ');

  return {
    canonical_title: canonicalTitle,
    who: extractWho(allText),
    what: extractWhat(claimsWithQuotes),
    when: extractWhen(allText),
    where: extractWhere(allText),
    key_facts: keyFacts,
    uncertainties,
    conflicts,
    coverage_summary: {
      sources_count: mediaKeys.size,
      source_names: [...mediaNames],
      articles_used: articles.length,
      total_text_len: totalTextLen,
    },
  };
}
