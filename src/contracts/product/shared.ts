/**
 * Shared product contract types.
 *
 * These types define the stable, public API surface for FUNDACION.
 * Any change to these types is a breaking change for frontend consumers.
 */

/** The 12 visible product topic keys (excludes internal OTROS fallback). */
export type ProductTopicKey =
  | 'SEGURIDAD'
  | 'ECONOMIA'
  | 'JUSTICIA'
  | 'SALUD'
  | 'EDUCACION'
  | 'CORRUPCION'
  | 'PROTESTA'
  | 'POLITICA'
  | 'RELACIONES_INT'
  | 'AMBIENTE'
  | 'TECNOLOGIA'
  | 'INFRAESTRUCTURA';

/** Closed set of confidence labels produced by the overview pipeline. */
export type OverviewConfidenceLabel =
  | 'Alta'
  | 'Media'
  | 'Baja'
  | 'Pendiente'
  | 'No concluyente';

export interface FeedCardTopic {
  key: ProductTopicKey;
  label: string;
}

export interface FeedCardSource {
  /** Stable identifier for frontend icon resolution. */
  media_key: string;
  /** Human-readable source name. */
  name: string;
}

/** Canonical label map for ProductTopicKey → display string. */
export const PRODUCT_TOPIC_LABELS: Record<ProductTopicKey, string> = {
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
};

/** Set of valid product topic keys for runtime validation. */
export const PRODUCT_TOPIC_KEYS = new Set<string>(Object.keys(PRODUCT_TOPIC_LABELS));
