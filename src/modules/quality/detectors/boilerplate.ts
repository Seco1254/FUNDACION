/**
 * Boilerplate detector — regex-based heuristic for Spanish news boilerplate
 * leaked into overview bullets or article text.
 */

const DEFAULT_PATTERNS: RegExp[] = [
  /\bsuscr[ií]b[ea]|suscripci[oó]n\b/i,
  /\bnewsletter\b/i,
  /\bregistr[ao]|reg[ií]str[aeo]se\b/i,
  /\bcookies?\b/i,
  /\bpublicidad\b/i,
  /\bcompartir en (facebook|twitter|whatsapp)\b/i,
  /\bseguir leyendo\b/i,
  /\bt[eé]rminos y condiciones\b/i,
  /\bpol[ií]tica de privacidad\b/i,
  /\binicia[r]? sesi[oó]n\b/i,
  /\bdescargar la app\b/i,
  /\bnotificaciones push\b/i,
  /\bcontenido exclusivo\b/i,
  /\bapp store|google play\b/i,
  /\bderechos reservados\b/i,
  /\bcerrar\s+(ventana|banner|aviso)\b/i,
];

export interface BoilerplateResult {
  rate: number;
  total: number;
  matched: number;
  matched_samples: string[];
}

export function detectBoilerplate(
  bullets: string[],
  extraPatterns?: RegExp[],
): BoilerplateResult {
  if (bullets.length === 0) {
    return { rate: 0, total: 0, matched: 0, matched_samples: [] };
  }

  const patterns = [...DEFAULT_PATTERNS, ...(extraPatterns ?? [])];
  let matched = 0;
  const samples: string[] = [];

  for (const bullet of bullets) {
    for (const pat of patterns) {
      if (pat.test(bullet)) {
        matched++;
        if (samples.length < 3) samples.push(bullet.slice(0, 120));
        break;
      }
    }
  }

  return {
    rate: matched / bullets.length,
    total: bullets.length,
    matched,
    matched_samples: samples,
  };
}
