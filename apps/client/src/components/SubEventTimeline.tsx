import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import type { SubEvent } from '../lib/types';

interface Props {
  subevents: SubEvent[];
}

const TYPE_LABELS: Record<string, string> = {
  topic_drift: 'Cambio de tema',
  claim_divergence: 'Divergencia',
};

export function SubEventTimeline({ subevents }: Props) {
  if (!subevents || subevents.length === 0) return null;

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Sub-eventos detectados</Text>
      <View style={styles.timeline}>
        {subevents.map((se, i) => (
          <View key={i} style={styles.item}>
            <View style={styles.dotCol}>
              <View style={styles.dot} />
              {i < subevents.length - 1 && <View style={styles.line} />}
            </View>
            <View style={styles.content}>
              <Text style={styles.type}>
                {TYPE_LABELS[se.type] ?? se.type}
              </Text>
              <Text style={styles.trigger}>{se.trigger}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.sm },
  title: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  timeline: { gap: 0 },
  item: { flexDirection: 'row', minHeight: 48 },
  dotCol: { width: 24, alignItems: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent, marginTop: 4 },
  line: { width: 2, flex: 1, backgroundColor: colors.border },
  content: { flex: 1, paddingLeft: spacing.sm, paddingBottom: spacing.md },
  type: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  trigger: { fontSize: font.xs, color: colors.textSecondary, marginTop: 2 },
});
