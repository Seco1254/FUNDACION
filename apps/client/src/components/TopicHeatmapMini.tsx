import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import type { HeatmapBin } from '../lib/types';

interface Props {
  bins: HeatmapBin[];
  onViewFull?: () => void;
}

const TOPIC_COLORS: Record<string, string> = {
  SEGURIDAD: '#DC2626',
  ECONOMIA: '#2563EB',
  JUSTICIA: '#7C3AED',
  SALUD: '#059669',
  EDUCACION: '#D97706',
  CORRUPCION: '#BE185D',
  PROTESTA: '#EA580C',
  POLITICA: '#4F46E5',
  RELACIONES_INT: '#0891B2',
  AMBIENTE: '#16A34A',
  TECNOLOGIA: '#6366F1',
  INFRAESTRUCTURA: '#78716C',
  OTROS: '#9CA3AF',
};

function getDominantTopic(topics: Record<string, number>): string {
  let max = 0;
  let dominant = 'OTROS';
  for (const [key, val] of Object.entries(topics)) {
    if (val > max) { max = val; dominant = key; }
  }
  return dominant;
}

export function TopicHeatmapMini({ bins, onViewFull }: Props) {
  if (!bins || bins.length === 0) return null;

  const displayBins = bins.slice(0, 14);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <Text style={styles.title}>Temas en el tiempo</Text>
        {onViewFull && (
          <Pressable onPress={onViewFull}>
            <Text style={styles.viewAll}>Ver todo</Text>
          </Pressable>
        )}
      </View>
      <View style={styles.grid}>
        {displayBins.map((bin) => {
          const dominant = getDominantTopic(bin.topics);
          const color = TOPIC_COLORS[dominant] ?? TOPIC_COLORS.OTROS;
          return (
            <View
              key={bin.bin_index}
              style={[styles.cell, { backgroundColor: color }]}
            />
          );
        })}
      </View>
    </View>
  );
}

export function HeatmapFull({ bins }: { bins: HeatmapBin[] }) {
  if (!bins || bins.length === 0) {
    return (
      <View style={styles.fullContainer}>
        <Text style={styles.empty}>Sin datos de heatmap disponibles.</Text>
      </View>
    );
  }

  return (
    <View style={styles.fullContainer}>
      <Text style={styles.fullTitle}>Mapa de calor de temas</Text>
      <View style={styles.fullGrid}>
        {bins.map((bin) => {
          const dominant = getDominantTopic(bin.topics);
          const color = TOPIC_COLORS[dominant] ?? TOPIC_COLORS.OTROS;
          return (
            <View key={bin.bin_index} style={styles.fullCellWrapper}>
              <View style={[styles.fullCell, { backgroundColor: color }]} />
              <Text style={styles.cellLabel}>{dominant.slice(0, 3)}</Text>
            </View>
          );
        })}
      </View>
      <View style={styles.legend}>
        {Object.entries(TOPIC_COLORS).slice(0, 8).map(([key, color]) => (
          <View key={key} style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: color }]} />
            <Text style={styles.legendText}>{key}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  viewAll: { fontSize: font.xs, color: colors.accent, fontWeight: '500' },
  grid: { flexDirection: 'row', gap: 2, flexWrap: 'wrap' },
  cell: { width: 20, height: 20, borderRadius: 3 },
  // Full
  fullContainer: { padding: spacing.lg, gap: spacing.md },
  fullTitle: { fontSize: font.lg, fontWeight: '600', color: colors.text },
  fullGrid: { flexDirection: 'row', gap: 4, flexWrap: 'wrap' },
  fullCellWrapper: { alignItems: 'center', gap: 2 },
  fullCell: { width: 28, height: 28, borderRadius: 4 },
  cellLabel: { fontSize: 8, color: colors.textMuted },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  legendDot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: font.xs, color: colors.textSecondary },
  empty: { fontSize: font.sm, color: colors.textMuted, textAlign: 'center', padding: spacing.xl },
});
