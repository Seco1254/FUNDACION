const ES_STOPWORDS = new Set([
  'de', 'la', 'que', 'el', 'en', 'y', 'a', 'los', 'del', 'se', 'las', 'por',
  'un', 'para', 'con', 'no', 'una', 'su', 'al', 'lo', 'como', 'más', 'pero',
  'sus', 'le', 'ya', 'o', 'este', 'si', 'porque', 'esta', 'entre', 'cuando',
  'muy', 'sin', 'sobre', 'también', 'me', 'hasta', 'hay', 'donde', 'quien',
  'desde', 'todo', 'nos', 'durante', 'todos', 'uno', 'les', 'ni', 'contra',
  'otros', 'ese', 'eso', 'ante', 'ellos', 'esto', 'antes', 'según',
  'fue', 'es', 'son', 'ser', 'han', 'ha', 'era', 'está',
]);

const EN_STOPWORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but', 'his',
  'by', 'from', 'they', 'we', 'say', 'her', 'she', 'or', 'an', 'will', 'my',
  'would', 'there', 'their', 'what', 'so', 'if', 'about', 'who', 'which',
  'when', 'can', 'could', 'should', 'was', 'were', 'been', 'has', 'had',
]);

const ES_THRESHOLD = 0.6;

export function isSpanish(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\s]/gu, '')
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) return false;

  let esCount = 0;
  let enCount = 0;

  for (const token of tokens) {
    if (ES_STOPWORDS.has(token)) esCount++;
    if (EN_STOPWORDS.has(token)) enCount++;
  }

  const totalStopwords = esCount + enCount;
  if (totalStopwords === 0) return true;

  const esRatio = esCount / totalStopwords;
  return esRatio >= ES_THRESHOLD;
}
