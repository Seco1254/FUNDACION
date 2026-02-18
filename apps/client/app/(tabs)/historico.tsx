import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { history } from '../../src/lib/history';
import { relativeTime } from '../../src/lib/cache';
import { PillTag } from '../../src/components/PillTag';
import { colors, spacing, font, radius } from '../../src/lib/theme';
import type { ViewedEvent, EventState } from '../../src/lib/types';

type Segment = 'vistos' | 'en_desarrollo' | 'cerrados';

function classifyEvent(event: ViewedEvent): Segment {
  if (event.state === 'CLOSED') return 'cerrados';

  // If backend provides state, use it
  if (event.state === 'PUBLISHED' || event.state === 'UPDATING') return 'en_desarrollo';

  // Infer closed if t_last > 7 days ago
  if (event.t_last) {
    const daysSince = (Date.now() - new Date(event.t_last).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 7) return 'cerrados';
  }

  return 'vistos';
}

export default function HistoricoScreen() {
  const router = useRouter();
  const [events, setEvents] = useState<ViewedEvent[]>([]);
  const [segment, setSegment] = useState<Segment>('vistos');

  useFocusEffect(
    useCallback(() => {
      history.getAll().then(setEvents);
    }, []),
  );

  const filtered = events.filter((e) => classifyEvent(e) === segment);

  const SEGMENTS: { key: Segment; label: string }[] = [
    { key: 'vistos', label: 'Vistos' },
    { key: 'en_desarrollo', label: 'En desarrollo' },
    { key: 'cerrados', label: 'Cerrados' },
  ];

  return (
    <View style={styles.container}>
      <View style={styles.segmentRow}>
        {SEGMENTS.map((s) => (
          <Pressable
            key={s.key}
            onPress={() => setSegment(s.key)}
            style={[styles.segmentBtn, segment === s.key && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, segment === s.key && styles.segmentTextActive]}>
              {s.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {filtered.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyText}>
            {segment === 'vistos' && 'Aún no has visto ningún evento.'}
            {segment === 'en_desarrollo' && 'Sin eventos en desarrollo vistos.'}
            {segment === 'cerrados' && 'Sin eventos cerrados vistos.'}
          </Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.event_id + item.viewed_at}
          renderItem={({ item }) => (
            <Pressable
              onPress={() => router.push(`/event/${item.event_id}`)}
              style={styles.row}
            >
              <View style={styles.rowContent}>
                <Text style={styles.rowHeadline} numberOfLines={2}>
                  {item.headline ?? 'Evento sin titular'}
                </Text>
                <View style={styles.rowMeta}>
                  <PillTag state={item.state} />
                  {item.viewed_at && (
                    <Text style={styles.viewedAt}>
                      Visto {relativeTime(item.viewed_at)}
                    </Text>
                  )}
                </View>
              </View>
            </Pressable>
          )}
          contentContainerStyle={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  segmentRow: { flexDirection: 'row', padding: spacing.lg, gap: spacing.sm },
  segmentBtn: { flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md, backgroundColor: colors.surfaceAlt, alignItems: 'center' },
  segmentActive: { backgroundColor: colors.primary },
  segmentText: { fontSize: font.sm, fontWeight: '500', color: colors.textSecondary },
  segmentTextActive: { color: '#FFFFFF' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  emptyText: { fontSize: font.md, color: colors.textMuted },
  list: { padding: spacing.lg, gap: spacing.sm },
  row: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg },
  rowContent: { gap: spacing.sm },
  rowHeadline: { fontSize: font.md, fontWeight: '600', color: colors.text },
  rowMeta: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  viewedAt: { fontSize: font.xs, color: colors.textMuted },
});
