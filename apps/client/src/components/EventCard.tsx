import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import { relativeTime } from '../lib/cache';
import type { FeedItem } from '../lib/types';

interface Props {
  item: FeedItem;
  onPress: () => void;
  onLongPress?: () => void;
  onRetryOverview?: () => void;
}

const PREVIEW_MAX_BULLETS = 3;

const EVIDENCE_LABELS: Record<string, { label: string; bg: string; text: string }> = {
  high: { label: 'Alta evidencia', bg: colors.successLight, text: colors.success },
  medium: { label: 'Evidencia media', bg: colors.accentLight, text: colors.accent },
  low: { label: 'Evidencia baja', bg: colors.warningLight, text: colors.warning },
};

export function EventCard({ item, onPress, onLongPress, onRetryOverview }: Props) {
  const updatedAt = relativeTime(item.updated_at);
  const [expanded, setExpanded] = useState(false);

  const ov = item.overview;
  const isReady = ov.status === 'ready';
  const isPending = ov.status === 'pending';
  const hasContent = ov.what_happened.length > 0 || ov.context.length > 0;
  const hasDispute = ov.in_dispute.length > 0;

  // Collect preview bullets: what_happened first, then context
  const allBullets: string[] = [];
  if (isReady && hasContent) {
    allBullets.push(...ov.what_happened);
    allBullets.push(...ov.context);
  }
  const previewBullets = expanded ? allBullets : allBullets.slice(0, PREVIEW_MAX_BULLETS);
  const canExpand = allBullets.length > PREVIEW_MAX_BULLETS;

  const evidenceInfo = EVIDENCE_LABELS[item.evidence_level];

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={styles.card}>
      <View style={styles.topRow}>
        {/* Evidence level badge replaces old state PillTag */}
        {evidenceInfo && (
          <View style={[styles.chip, { backgroundColor: evidenceInfo.bg }]}>
            <Text style={[styles.chipText, { color: evidenceInfo.text }]}>{evidenceInfo.label}</Text>
          </View>
        )}
        {hasDispute && (
          <View style={styles.chipDispute}>
            <Text style={styles.chipDisputeText}>En disputa</Text>
          </View>
        )}
        {item.source_count > 0 && (
          <View style={styles.chipSources}>
            <Text style={styles.chipSourcesText}>
              {item.source_count} fuente{item.source_count !== 1 ? 's' : ''}
            </Text>
          </View>
        )}
        {item.topic && (
          <View style={styles.chipTopic}>
            <Text style={styles.chipTopicText}>{item.topic.label}</Text>
          </View>
        )}
      </View>

      <Text style={styles.headline} numberOfLines={3}>
        {item.headline}
      </Text>

      {/* AI Overview preview */}
      {isReady && hasContent ? (
        <View style={styles.overviewBlock}>
          <Text style={styles.overviewLabel}>Resumen (IA)</Text>
          {previewBullets.map((bullet, i) => (
            <Text key={i} style={styles.overviewBullet} numberOfLines={expanded ? undefined : 2}>
              {'•  '}{bullet}
            </Text>
          ))}
          {hasDispute && !expanded && (
            <Text style={styles.disputeHint}>
              {'⚠  '}{ov.in_dispute[0]}
            </Text>
          )}
          {canExpand && (
            <Pressable
              onPress={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
              hitSlop={8}
            >
              <Text style={styles.expandToggle}>
                {expanded ? 'Mostrar menos' : 'Ver más'}
              </Text>
            </Pressable>
          )}
          {ov.confidence_label && (
            <Text style={styles.confidenceLabel}>{ov.confidence_label}</Text>
          )}
        </View>
      ) : ov.status === 'unavailable' ? (
        <View style={styles.overviewPlaceholder}>
          <Text style={styles.placeholderTitle}>Resumen no disponible</Text>
          <Text style={styles.placeholderSubtitle}>
            No hay suficiente evidencia cruzada todavía.
          </Text>
        </View>
      ) : (
        <View style={styles.overviewPlaceholder}>
          <Text style={styles.placeholderTitle}>Aún no hay resumen</Text>
          <Text style={styles.placeholderSubtitle}>
            El análisis de fuentes está en proceso.
          </Text>
          {onRetryOverview && (
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
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  chipText: {
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
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
  chipTopic: {
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  chipTopicText: {
    fontSize: font.xs,
    fontWeight: '500',
    color: colors.textSecondary,
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
  overviewBullet: {
    fontSize: font.sm,
    color: colors.text,
    lineHeight: 20,
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
