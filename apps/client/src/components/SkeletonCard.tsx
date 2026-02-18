import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import { colors, spacing, radius } from '../lib/theme';

export function SkeletonCard() {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    anim.start();
    return () => anim.stop();
  }, [opacity]);

  return (
    <View style={styles.card}>
      <Animated.View style={[styles.pill, { opacity }]} />
      <Animated.View style={[styles.headline, { opacity }]} />
      <Animated.View style={[styles.headlineSm, { opacity }]} />
      <Animated.View style={[styles.body, { opacity }]} />
      <Animated.View style={[styles.body, { opacity, width: '80%' }]} />
      <Animated.View style={[styles.body, { opacity, width: '60%' }]} />
      <View style={styles.footer}>
        <Animated.View style={[styles.meta, { opacity }]} />
        <Animated.View style={[styles.cta, { opacity }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    gap: spacing.md,
  },
  pill: { width: 80, height: 22, borderRadius: radius.full, backgroundColor: colors.surfaceAlt },
  headline: { width: '90%', height: 24, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  headlineSm: { width: '60%', height: 24, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  body: { width: '100%', height: 14, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  footer: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.sm },
  meta: { width: 120, height: 14, borderRadius: radius.sm, backgroundColor: colors.surfaceAlt },
  cta: { width: 90, height: 36, borderRadius: radius.md, backgroundColor: colors.surfaceAlt },
});
