/**
 * Geographic relevance classifier for Colombian corpus filtering.
 *
 * Three tiers:
 *   - local:         mentions Colombian places, institutions, or conflict actors
 *   - regional:      mentions Latin American countries or regional terms
 *   - international: no Colombian or LatAm geographic signal
 *
 * Kill switch: GEO_FILTER_ENABLED=0 disables blocking (classification still runs for observability).
 */

export type GeoTier = 'local' | 'regional' | 'international';

export interface GeoRelevanceResult {
  tier: GeoTier;
  matchedKeywords: string[];
}

// Kill switch — set GEO_FILTER_ENABLED=0 to disable blocking
const GEO_FILTER_ENABLED = process.env.GEO_FILTER_ENABLED !== '0';

export function isGeoFilterEnabled(): boolean {
  return GEO_FILTER_ENABLED;
}

// ── Colombian signals (Tier 1 → 'local') ───────────────────────────

const COLOMBIAN_KEYWORDS: string[] = [
  // The word "Colombia" itself
  'Colombia', 'colombiano', 'colombiana', 'colombianos', 'colombianas',
  // 32 departamentos
  'Amazonas', 'Antioquia', 'Arauca', 'Atlántico', 'Bolívar', 'Boyacá',
  'Caldas', 'Caquetá', 'Casanare', 'Cauca', 'Cesar', 'Chocó', 'Córdoba',
  'Cundinamarca', 'Guainía', 'Guaviare', 'Huila', 'La Guajira', 'Magdalena',
  'Meta', 'Nariño', 'Norte de Santander', 'Putumayo', 'Quindío', 'Risaralda',
  'San Andrés', 'Santander', 'Sucre', 'Tolima', 'Valle del Cauca', 'Vaupés', 'Vichada',
  // Major cities
  'Bogotá', 'Medellín', 'Cali', 'Barranquilla', 'Cartagena', 'Bucaramanga',
  'Cúcuta', 'Pereira', 'Manizales', 'Santa Marta', 'Ibagué', 'Villavicencio',
  'Pasto', 'Buenaventura', 'Tumaco', 'Quibdó', 'Popayán', 'Montería',
  'Valledupar', 'Neiva', 'Sincelejo', 'Florencia', 'Riohacha', 'Tunja',
  'Armenia', 'Mocoa', 'Leticia', 'Yopal', 'Apartadó',
  // Institutions
  'Congreso', 'Senado', 'Cámara de Representantes', 'Corte Constitucional',
  'Corte Suprema', 'Fiscalía', 'Procuraduría', 'Defensoría', 'JEP',
  'Contraloría', 'DANE', 'ICBF',
  // Conflict actors
  'FARC', 'ELN', 'Clan del Golfo', 'AGC', 'AUC', 'paramilitares',
  'autodefensas', 'guerrilla colombiana', 'disidencias',
  // Key conflict/peace terms
  'Acuerdo de Paz', 'proceso de paz', 'restitución de tierras',
  'desplazamiento forzado', 'falsos positivos', 'líderes sociales',
  // Rural / agricultural sector
  'campesinos', 'campesino', 'reforma agraria',
  'MinAgricultura', 'Ministerio de Agricultura',
  'ICA', 'SENA', 'ANT', 'Agencia Nacional de Tierras',
  'ADR', 'Agencia de Desarrollo Rural', 'Fedegán', 'SAC',
];

// ── Latin American signals (Tier 2 → 'regional') ───────────────────

const LATAM_KEYWORDS: string[] = [
  'Venezuela', 'Ecuador', 'Perú', 'Brasil', 'México', 'Argentina', 'Chile',
  'Bolivia', 'Panamá', 'Cuba', 'Guatemala', 'Honduras', 'Nicaragua',
  'El Salvador', 'Costa Rica', 'Paraguay', 'Uruguay', 'República Dominicana',
  'Haití', 'Puerto Rico',
  'América Latina', 'Latinoamérica', 'latinoamericano', 'latinoamericana',
  'Abya Yala', 'Centroamérica', 'Sudamérica', 'Caribe',
];

// ── Pre-compiled regexes ────────────────────────────────────────────

function buildWordBoundaryRegex(keyword: string): RegExp {
  // Escape regex special chars, case-insensitive.
  // Use Unicode-aware word boundaries: lookbehind/lookahead for non-letter chars
  // because \b doesn't work with accented characters (á, é, ñ, etc.)
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<=^|[^\\p{L}])${escaped}(?=[^\\p{L}]|$)`, 'iu');
}

const COLOMBIAN_PATTERNS = COLOMBIAN_KEYWORDS.map((kw) => ({
  keyword: kw,
  regex: buildWordBoundaryRegex(kw),
}));

const LATAM_PATTERNS = LATAM_KEYWORDS.map((kw) => ({
  keyword: kw,
  regex: buildWordBoundaryRegex(kw),
}));

// ── Classifier ──────────────────────────────────────────────────────

export function classifyGeoRelevance(title: string, snippet: string): GeoRelevanceResult {
  const text = `${title} ${snippet}`;

  // Check Colombian signals first
  const colMatches: string[] = [];
  for (const { keyword, regex } of COLOMBIAN_PATTERNS) {
    if (regex.test(text)) {
      colMatches.push(keyword);
    }
  }
  if (colMatches.length > 0) {
    return { tier: 'local', matchedKeywords: colMatches };
  }

  // Check LatAm signals
  const latamMatches: string[] = [];
  for (const { keyword, regex } of LATAM_PATTERNS) {
    if (regex.test(text)) {
      latamMatches.push(keyword);
    }
  }
  if (latamMatches.length > 0) {
    return { tier: 'regional', matchedKeywords: latamMatches };
  }

  // No geographic signal
  return { tier: 'international', matchedKeywords: [] };
}
