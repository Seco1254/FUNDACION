import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing, font, radius } from '../lib/theme';
import type { QuoteHighlight } from '../lib/types';

interface Props {
  quote: QuoteHighlight;
}

const STRENGTH_LABELS: Record<string, string> = {
  STRONG: 'Fuerte',
  MEDIUM: 'Media',
  WEAK: 'Débil',
};

export function QuoteHighlightCard({ quote }: Props) {
  return (
    <View style={styles.card}>
      <View style={styles.quoteBar} />
      <View style={styles.content}>
        <Text style={styles.quoteText}>"{quote.quote_text}"</Text>
        {quote.strength && (
          <Text style={styles.strength}>
            Relevancia: {STRENGTH_LABELS[quote.strength] ?? quote.strength}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: colors.surfaceAlt,
    borderRadius: radius.md,
    overflow: 'hidden',
  },
  quoteBar: {
    width: 3,
    backgroundColor: colors.accent,
  },
  content: {
    flex: 1,
    padding: spacing.md,
    gap: spacing.xs,
  },
  quoteText: {
    fontSize: font.sm,
    color: colors.text,
    fontStyle: 'italic',
    lineHeight: 20,
  },
  strength: {
    fontSize: font.xs,
    color: colors.textMuted,
  },
});
