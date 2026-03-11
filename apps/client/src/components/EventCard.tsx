import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import { PillTag } from './PillTag';
import { relativeTime } from '../lib/cache';
import type { FeedItem } from '../lib/types';

interface Props {
  item: FeedItem;
  onPress: () => void;
  onLongPress?: () => void;
  onRetryOverview?: () => void;
}

export function EventCard({ item, onPress, onLongPress, onRetryOverview }: Props) {
  const updatedAt = relativeTime(item.t_last);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const ov = item.ai_overview;
  const hasOverview = ov && (ov.what_happened.length > 0 || ov.context.length > 0);
  const hasDispute = ov && ov.in_dispute.length > 0;
  // 'blocked' = processed but insufficient data; undefined = not yet processed (pending)
  const isBlocked = !hasOverview && item.overview_status?.state === 'blocked';

  // Show narrative overview paragraph whenever it exists (backend guarantees quality)
  const overviewParagraph = ov?.overview?.trim() ?? '';
  const hasNarrativeOverview = overviewParagraph.length > 0;

  // Source analysis section
  const af = ov?.analisis_fuentes;
  const hasAnalisisFuentes = af && (
    (af.consenso?.length ?? 0) > 0 ||
    (af.desacuerdo?.length ?? 0) > 0 ||
    (af.informacion_faltante?.length ?? 0) > 0
  );

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={styles.card}>
      <View style={styles.topRow}>
        <PillTag state={item.state} />
        {hasDispute && (
          <View style={styles.chipDispute}>
            <Text style={styles.chipDisputeText}>En disputa</Text>
          </View>
        )}
        {item.source_count != null && item.source_count > 0 && (
          <View style={styles.chipSources}>
            <Text style={styles.chipSourcesText}>
              {item.source_count} fuente{item.source_count !== 1 ? 's' : ''}
            </Text>
          </View>
        )}
      </View>

      <Text style={styles.headline} numberOfLines={3}>
        {item.headline ?? 'Evento en desarrollo...'}
      </Text>

      {/* AI Overview: narrative-first layout */}
      {hasOverview ? (
        <View style={styles.overviewBlock}>
          <Text style={styles.overviewLabel}>Resumen (IA)</Text>

          {/* Primary: narrative overview paragraph */}
          {hasNarrativeOverview ? (
            <>
              <Text style={styles.overviewParagraph}>{overviewParagraph}</Text>

              {/* Collapsible details */}
              <Pressable
                onPress={(e) => { e.stopPropagation(); setDetailsExpanded(!detailsExpanded); }}
                hitSlop={8}
              >
                <Text style={styles.expandToggle}>
                  {detailsExpanded ? 'Mostrar menos' : 'Ver detalles'}
                </Text>
              </Pressable>

              {detailsExpanded && (
                <View style={styles.detailsContainer}>
                  {ov!.what_happened.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>Hechos clave</Text>
                      {ov!.what_happened.map((bullet, i) => (
                        <Text key={`wh-${i}`} style={styles.overviewBullet}>{'•  '}{bullet}</Text>
                      ))}
                    </View>
                  )}
                  {ov!.context.length > 0 && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>Contexto</Text>
                      {ov!.context.map((bullet, i) => (
                        <Text key={`ctx-${i}`} style={styles.overviewBullet}>{'•  '}{bullet}</Text>
                      ))}
                    </View>
                  )}
                  {hasAnalisisFuentes ? (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>Análisis de fuentes</Text>
                      {(af!.consenso ?? []).map((c, i) => (
                        <Text key={`cons-${i}`} style={styles.consensusBullet}>{'✓  '}{c}</Text>
                      ))}
                      {(af!.desacuerdo ?? []).map((d, i) => (
                        <Text key={`dis-${i}`} style={styles.disputeHint}>{'⚠  '}{d}</Text>
                      ))}
                      {(af!.informacion_faltante ?? []).map((f, i) => (
                        <Text key={`falt-${i}`} style={styles.missingInfoBullet}>{'?  '}{f}</Text>
                      ))}
                    </View>
                  ) : hasDispute && (
                    <View style={styles.detailSection}>
                      <Text style={styles.detailSectionTitle}>En disputa</Text>
                      {ov!.in_dispute.map((bullet, i) => (
                        <Text key={`disp-${i}`} style={styles.disputeHint}>{'⚠  '}{bullet}</Text>
                      ))}
                    </View>
                  )}
                </View>
              )}
            </>
          ) : (
            /* Fallback: bullet-based layout (no narrative paragraph available) */
            <>
              {ov!.what_happened.slice(0, 3).map((bullet, i) => (
                <Text key={i} style={styles.overviewBullet} numberOfLines={2}>
                  {'•  '}{bullet}
                </Text>
              ))}
              {hasDispute && (
                <Text style={styles.disputeHint}>
                  {'⚠  '}{ov!.in_dispute[0]}
                </Text>
              )}
              {(ov!.what_happened.length > 3 || ov!.context.length > 0) && (
                <Pressable
                  onPress={(e) => { e.stopPropagation(); setDetailsExpanded(!detailsExpanded); }}
                  hitSlop={8}
                >
                  <Text style={styles.expandToggle}>
                    {detailsExpanded ? 'Mostrar menos' : 'Ver más'}
                  </Text>
                </Pressable>
              )}
              {detailsExpanded && (
                <>
                  {ov!.what_happened.slice(3).map((bullet, i) => (
                    <Text key={`wh-extra-${i}`} style={styles.overviewBullet}>{'•  '}{bullet}</Text>
                  ))}
                  {ov!.context.map((bullet, i) => (
                    <Text key={`ctx-${i}`} style={styles.overviewBullet}>{'•  '}{bullet}</Text>
                  ))}
                </>
              )}
            </>
          )}

          {ov!.confidence_label && (
            <Text style={styles.confidenceLabel}>{ov!.confidence_label}</Text>
          )}
        </View>
      ) : isBlocked ? (
        <View style={styles.overviewPlaceholder}>
          <Text style={styles.placeholderText}>Datos insuficientes por ahora</Text>
          <Text style={styles.placeholderHint}>Se necesitan más fuentes para generar un resumen.</Text>
        </View>
      ) : (
        <View style={styles.overviewPlaceholder}>
          {item.overview_status === 'unavailable' ? (
            <>
              <Text style={styles.placeholderTitle}>Resumen no disponible</Text>
              <Text style={styles.placeholderSubtitle}>
                No hay suficiente evidencia cruzada todavía.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.placeholderTitle}>Aún no hay resumen</Text>
              <Text style={styles.placeholderSubtitle}>
                El análisis de fuentes está en proceso.
              </Text>
            </>
          )}
          {onRetryOverview && item.overview_status !== 'unavailable' && (
            <Pressable
              onPress={(e) => { e.stopPropagation(); onRetryOverview(); }}
              style={styles.retryBtn}
              hitSlop={8}
            >
              <Text style={styles.retryText}>Reintentar</Text>
            </Pressable>
          )}
        </View>
      )}

      <View style={styles.footer}>
        <View style={styles.meta}>
          {updatedAt && (
            <Text style={styles.metaText}>Actualizado {updatedAt}</Text>
          )}
        </View>
        <View style={styles.cta}>
          <Text style={styles.ctaText}>Ver detalle</Text>
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginHorizontal: spacing.lg,
    gap: spacing.md,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 4,
    elevation: 2,
    flex: 1,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    flexWrap: 'wrap',
  },
  chipDispute: {
    backgroundColor: colors.warningLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  chipDisputeText: {
    fontSize: font.xs,
    fontWeight: '600',
    color: colors.warning,
  },
  chipSources: {
    backgroundColor: colors.accentLight,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  chipSourcesText: {
    fontSize: font.xs,
    fontWeight: '500',
    color: colors.accent,
  },
  headline: {
    fontSize: font.xl,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 28,
  },
  // AI Overview preview
  overviewBlock: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
    gap: spacing.xs,
    flex: 1,
  },
  overviewLabel: {
    fontSize: font.xs,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: spacing.xs,
  },
  overviewParagraph: {
    fontSize: font.sm,
    color: colors.text,
    lineHeight: 22,
  },
  overviewBullet: {
    fontSize: font.sm,
    color: colors.text,
    lineHeight: 20,
  },
  detailsContainer: {
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  detailSection: {
    gap: spacing.xs,
  },
  detailSectionTitle: {
    fontSize: font.xs,
    fontWeight: '600',
    color: colors.textSecondary,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  consensusBullet: {
    fontSize: font.sm,
    color: colors.text,
    lineHeight: 20,
  },
  missingInfoBullet: {
    fontSize: font.sm,
    color: colors.textMuted,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  disputeHint: {
    fontSize: font.sm,
    color: colors.warning,
    lineHeight: 20,
    fontStyle: 'italic',
  },
  expandToggle: {
    fontSize: font.sm,
    color: colors.accent,
    fontWeight: '500',
    marginTop: spacing.xs,
  },
  confidenceLabel: {
    fontSize: font.xs,
    color: colors.textMuted,
    marginTop: spacing.xs,
  },
  // Placeholder — no overview yet
  overviewPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    flex: 1,
    justifyContent: 'center',
  },
  placeholderTitle: {
    fontSize: font.md,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  placeholderSubtitle: {
    fontSize: font.sm,
    color: colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: font.sm,
    fontWeight: '600',
  },
  placeholderHint: {
    fontSize: font.xs,
    color: colors.textMuted,
    marginTop: 2,
  },
  footer: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  meta: {
    flex: 1,
  },
  metaText: {
    fontSize: font.xs,
    color: colors.textMuted,
  },
  cta: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  ctaText: {
    color: '#FFFFFF',
    fontSize: font.sm,
    fontWeight: '600',
  },
});
