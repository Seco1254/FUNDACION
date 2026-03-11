import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import type { Overview, OverviewSection, CitationRef } from '../lib/types';

interface OverviewBlockProps {
  overview: Overview;
  overviewStatus?: 'ready' | 'unavailable' | 'pending';
  collapsed?: boolean;
  onRetry?: () => void;
}

const MAX_BULLETS_COLLAPSED = 4;

export function OverviewBlock({ overview, overviewStatus, collapsed = false, onRetry }: OverviewBlockProps) {
  if (!overview.sections || overview.sections.length === 0) {
    if (overviewStatus === 'unavailable') {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>Resumen no disponible</Text>
          <Text style={styles.emptySubtitle}>No hay suficiente evidencia cruzada todavía.</Text>
        </View>
      );
    }
    if (overview.status === 'NOT_READY' || overviewStatus === 'pending') {
      return (
        <View style={styles.emptyContainer}>
          <Text style={styles.emptyTitle}>Aún no hay resumen</Text>
          <Text style={styles.emptySubtitle}>Vuelve en unos minutos.</Text>
          {onRetry && (
            <Pressable onPress={onRetry} style={styles.retryBtn}>
              <Text style={styles.retryText}>Reintentar</Text>
            </Pressable>
          )}
        </View>
      );
    }
    return null;
  }

  return (
    <View style={styles.container}>
      {overview.sections.map((section) => (
        <SectionBlock key={section.key} section={section} initialCollapsed={collapsed} />
      ))}
    </View>
  );
}

function SectionBlock({ section, initialCollapsed }: { section: OverviewSection; initialCollapsed: boolean }) {
  const hasBullets = section.bullets.length > 0;
  const needsCollapse = hasBullets && section.bullets.length > MAX_BULLETS_COLLAPSED;
  const [expanded, setExpanded] = useState(!initialCollapsed);
  const [showAll, setShowAll] = useState(!needsCollapse);

  const visibleBullets = showAll ? section.bullets : section.bullets.slice(0, MAX_BULLETS_COLLAPSED);

  return (
    <View style={styles.section}>
      <Pressable onPress={() => setExpanded(!expanded)} style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{section.title}</Text>
        {hasBullets && (
          <Text style={styles.chevron}>{expanded ? '▾' : '▸'}</Text>
        )}
      </Pressable>
      {expanded && hasBullets && (
        <View style={styles.bullets}>
          {visibleBullets.map((bullet) => (
            <View key={bullet.claim_id} style={styles.bullet}>
              <Text style={styles.bulletDot}>•</Text>
              <View style={styles.bulletContent}>
                <Text style={styles.bulletText}>{bullet.text}</Text>
                {bullet.citation_refs.length > 0 && (
                  <View style={styles.citations}>
                    {bullet.citation_refs.map((ref) => (
                      <CitationLink key={ref.quote_id} citation={ref} />
                    ))}
                  </View>
                )}
              </View>
            </View>
          ))}
          {needsCollapse && (
            <Pressable onPress={() => setShowAll(!showAll)} hitSlop={8}>
              <Text style={styles.showMoreToggle}>
                {showAll ? 'Mostrar menos' : `Ver ${section.bullets.length - MAX_BULLETS_COLLAPSED} más`}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {expanded && !hasBullets && (
        <Text style={styles.empty}>Sin información disponible.</Text>
      )}
    </View>
  );
}

function CitationLink({ citation }: { citation: CitationRef }) {
  return (
    <Pressable
      onPress={() => { if (citation.url) Linking.openURL(citation.url); }}
      style={styles.citationLink}
    >
      <Text style={styles.citationText}>Ver evidencia ({citation.media_key})</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  // Empty / not ready state
  emptyContainer: {
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  emptyTitle: {
    fontSize: font.md,
    fontWeight: '600',
    color: colors.textSecondary,
  },
  emptySubtitle: {
    fontSize: font.sm,
    color: colors.textMuted,
  },
  retryBtn: {
    backgroundColor: colors.primary,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    marginTop: spacing.sm,
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: font.sm,
    fontWeight: '600',
  },
  // Section layout
  section: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingBottom: spacing.sm,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
  },
  sectionTitle: {
    fontSize: font.md,
    fontWeight: '600',
    color: colors.text,
  },
  chevron: { fontSize: font.md, color: colors.textSecondary },
  bullets: { gap: spacing.md, paddingLeft: spacing.xs },
  bullet: { flexDirection: 'row', gap: spacing.sm },
  bulletDot: { fontSize: font.md, color: colors.textSecondary, lineHeight: 24 },
  bulletContent: { flex: 1 },
  bulletText: {
    fontSize: font.md,
    color: colors.text,
    lineHeight: 24,
  },
  citations: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginTop: spacing.xs,
  },
  citationLink: {
    paddingVertical: 2,
    paddingHorizontal: spacing.sm,
    backgroundColor: colors.accentLight,
    borderRadius: radius.sm,
  },
  citationText: { fontSize: font.xs, color: colors.accent, fontWeight: '500' },
  showMoreToggle: {
    fontSize: font.sm,
    color: colors.accent,
    fontWeight: '500',
    marginTop: spacing.xs,
  },
  empty: {
    color: colors.textMuted,
    fontSize: font.sm,
    fontStyle: 'italic',
    paddingVertical: spacing.xs,
  },
});
