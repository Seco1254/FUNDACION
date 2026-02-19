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
}

const PREVIEW_MAX_BULLETS = 3;

export function EventCard({ item, onPress, onLongPress }: Props) {
  const updatedAt = relativeTime(item.t_last);
  const [expanded, setExpanded] = useState(false);
  const ov = item.ai_overview;
  const hasOverview = ov && (ov.what_happened.length > 0 || ov.context.length > 0);
  const hasDispute = ov && ov.in_dispute.length > 0;
  // 'blocked' = processed but insufficient data; undefined = not yet processed (pending)
  const isBlocked = !hasOverview && item.overview_status?.state === 'blocked';

  // Collect preview bullets: what_happened first, then context
  const allBullets: string[] = [];
  if (ov) {
    allBullets.push(...ov.what_happened);
    allBullets.push(...ov.context);
  }
  const previewBullets = expanded ? allBullets : allBullets.slice(0, PREVIEW_MAX_BULLETS);
  const canExpand = allBullets.length > PREVIEW_MAX_BULLETS;

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

      {/* AI Overview preview */}
      {hasOverview ? (
        <View style={styles.overviewBlock}>
          <Text style={styles.overviewLabel}>Resumen (IA)</Text>
          {previewBullets.map((bullet, i) => (
            <Text key={i} style={styles.overviewBullet} numberOfLines={expanded ? undefined : 2}>
              {'•  '}{bullet}
            </Text>
          ))}
          {hasDispute && !expanded && (
            <Text style={styles.disputeHint}>
              {'⚠  '}{ov!.in_dispute[0]}
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
          <Text style={styles.placeholderText}>Generando resumen…</Text>
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
  // Placeholder
  overviewPlaceholder: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  placeholderText: {
    fontSize: font.sm,
    color: colors.textMuted,
    fontStyle: 'italic',
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
