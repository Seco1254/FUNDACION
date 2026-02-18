import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';

interface ConfidenceBadgeProps {
  gateStatus: string | undefined;
}

export function ConfidenceBadge({ gateStatus }: ConfidenceBadgeProps) {
  if (!gateStatus || gateStatus === 'NA') return null;

  const isPass = gateStatus === 'PASS';
  const label = isPass ? 'CONCLUYENTE' : 'INCONCLUSO';
  const bg = isPass ? colors.successLight : colors.inconclusoLight;
  const textColor = isPass ? colors.success : colors.inconcluso;

  return (
    <View style={[styles.badge, { backgroundColor: bg }]}>
      <Text style={[styles.text, { color: textColor }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    alignSelf: 'flex-start',
  },
  text: {
    fontSize: font.xs,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});
