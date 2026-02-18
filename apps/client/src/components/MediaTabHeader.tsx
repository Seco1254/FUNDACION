import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';

interface Props {
  mediaKey: string;
  biasLabel?: string | null;
}

function getInitials(key: string): string {
  return key.slice(0, 2).toUpperCase();
}

function formatMediaName(key: string): string {
  return key
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function MediaTabHeader({ mediaKey, biasLabel }: Props) {
  return (
    <View style={styles.header}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{getInitials(mediaKey)}</Text>
      </View>
      <View style={styles.info}>
        <Text style={styles.name}>{formatMediaName(mediaKey)}</Text>
        {biasLabel && (
          <Text style={styles.label}>
            Patrón observado: {biasLabel}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: {
    color: '#FFFFFF',
    fontSize: font.sm,
    fontWeight: '700',
  },
  info: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: font.md,
    fontWeight: '600',
    color: colors.text,
  },
  label: {
    fontSize: font.xs,
    color: colors.textSecondary,
  },
});
