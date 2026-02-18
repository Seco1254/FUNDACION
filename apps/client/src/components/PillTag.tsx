import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';

const STATE_COLORS: Record<string, { bg: string; text: string }> = {
  PUBLISHED: { bg: colors.successLight, text: colors.success },
  UPDATING: { bg: colors.accentLight, text: colors.accent },
  CLOSED: { bg: colors.surfaceAlt, text: colors.textSecondary },
  DORMANT: { bg: colors.warningLight, text: colors.warning },
  DETECTED: { bg: colors.accentLight, text: colors.accent },
  PENDING_PUBLISH: { bg: colors.warningLight, text: colors.warning },
};

const STATE_LABELS: Record<string, string> = {
  PUBLISHED: 'Publicado',
  UPDATING: 'Actualizando',
  CLOSED: 'Cerrado',
  DORMANT: 'En pausa',
  DETECTED: 'Detectado',
  PENDING_PUBLISH: 'Por publicar',
};

interface PillTagProps {
  state: string;
}

export function PillTag({ state }: PillTagProps) {
  const color = STATE_COLORS[state] ?? { bg: colors.surfaceAlt, text: colors.textSecondary };
  const label = STATE_LABELS[state] ?? state;

  return (
    <View style={[styles.pill, { backgroundColor: color.bg }]}>
      <Text style={[styles.text, { color: color.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: font.xs,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
});
