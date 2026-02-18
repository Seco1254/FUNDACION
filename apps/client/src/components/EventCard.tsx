import React from 'react';
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

export function EventCard({ item, onPress, onLongPress }: Props) {
  const updatedAt = relativeTime(item.t_last);

  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={styles.card}>
      <View style={styles.topRow}>
        <PillTag state={item.state} />
      </View>

      <Text style={styles.headline} numberOfLines={3}>
        {item.headline ?? 'Evento en desarrollo...'}
      </Text>

      {/* TODO: BACKEND GAP — overview sections not in feed response; shown only in detail */}

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
  },
  headline: {
    fontSize: font.xl,
    fontWeight: '700',
    color: colors.text,
    lineHeight: 28,
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
