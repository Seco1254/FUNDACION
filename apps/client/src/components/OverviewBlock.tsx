import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Linking } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import type { Overview, OverviewSection, CitationRef } from '../lib/types';

interface OverviewBlockProps {
  overview: Overview;
  collapsed?: boolean;
}

export function OverviewBlock({ overview, collapsed = false }: OverviewBlockProps) {
  if (!overview.sections || overview.sections.length === 0) {
    if (overview.status === 'NOT_READY') {
      return (
        <View style={styles.container}>
          <Text style={styles.notReady}>El resumen aún se está generando...</Text>
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
  const [expanded, setExpanded] = useState(!initialCollapsed);
  const hasBullets = section.bullets.length > 0;

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
          {section.bullets.map((bullet) => (
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
  container: { gap: spacing.xs },
  notReady: { color: colors.textMuted, fontSize: font.sm, fontStyle: 'italic', padding: spacing.md },
  section: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingBottom: spacing.sm },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.sm },
  sectionTitle: { fontSize: font.md, fontWeight: '600', color: colors.text },
  chevron: { fontSize: font.md, color: colors.textSecondary },
  bullets: { gap: spacing.sm, paddingLeft: spacing.xs },
  bullet: { flexDirection: 'row', gap: spacing.sm },
  bulletDot: { fontSize: font.md, color: colors.textSecondary, lineHeight: 22 },
  bulletContent: { flex: 1 },
  bulletText: { fontSize: font.sm, color: colors.text, lineHeight: 20 },
  citations: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  citationLink: { paddingVertical: 2, paddingHorizontal: spacing.xs, backgroundColor: colors.accentLight, borderRadius: radius.sm },
  citationText: { fontSize: font.xs, color: colors.accent, fontWeight: '500' },
  empty: { color: colors.textMuted, fontSize: font.sm, fontStyle: 'italic', paddingVertical: spacing.xs },
});
