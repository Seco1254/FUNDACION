import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  Alert,
  ActionSheetIOS,
  Platform,
  StyleSheet,
  Dimensions,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import { api, ApiError } from '../../src/lib/api';
import { cache } from '../../src/lib/cache';
import { EventCard } from '../../src/components/EventCard';
import { SkeletonCard } from '../../src/components/SkeletonCard';
import { colors, spacing, font, radius } from '../../src/lib/theme';
import type { FeedItem, FeedResponse } from '../../src/lib/types';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
const CARD_HEIGHT = SCREEN_HEIGHT - 180; // approx snap height

type Status = 'loading' | 'error' | 'empty' | 'ok' | 'offline';

export default function ForYouScreen() {
  const router = useRouter();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);

  const loadFeed = useCallback(async (cursor?: string, isRefresh = false) => {
    try {
      const data = await api.getFeed(cursor);
      if (__DEV__) console.debug(`[feed] fetched count=${data.items.length} cursor=${cursor ?? 'first'} ts=${new Date().toISOString()}`);
      await cache.setFeed(data, cursor);

      if (isRefresh || !cursor) {
        setItems(data.items);
      } else {
        setItems((prev) => [...prev, ...data.items]);
      }
      setNextCursor(data.next_cursor);
      setStatus(data.items.length === 0 && !cursor ? 'empty' : 'ok');
      setCachedAt(null);
    } catch (err) {
      // Try cached on network error
      if (!cursor) {
        const cached = await cache.getFeed();
        if (cached) {
          setItems(cached.data.items);
          setNextCursor(cached.data.next_cursor);
          setStatus('offline');
          setCachedAt(new Date(cached.timestamp).toLocaleTimeString());
          return;
        }
      }
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    loadFeed();
  }, [loadFeed]);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFeed(undefined, true);
    setRefreshing(false);
  }, [loadFeed]);

  const handleLoadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    await loadFeed(nextCursor);
    setLoadingMore(false);
  }, [nextCursor, loadingMore, loadFeed]);

  const handleLongPress = useCallback((item: FeedItem) => {
    const options = ['Compartir', 'Copiar enlace', 'Ver metodología', 'Cancelar'];
    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: 3 },
        (idx) => {
          if (idx === 0 || idx === 1) {
            Alert.alert('Enlace no disponible por ahora.');
          } else if (idx === 2) {
            router.push('/(tabs)/acerca');
          }
        },
      );
    } else {
      // Android / Web — simple alert
      Alert.alert('Opciones', undefined, [
        { text: 'Compartir', onPress: () => Alert.alert('Enlace no disponible por ahora.') },
        { text: 'Ver metodología', onPress: () => router.push('/(tabs)/acerca') },
        { text: 'Cancelar', style: 'cancel' },
      ]);
    }
  }, [router]);

  if (status === 'loading') {
    return (
      <View style={styles.container}>
        <SkeletonCard />
        <SkeletonCard />
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>No pudimos cargar el feed.</Text>
        <Pressable onPress={() => { setStatus('loading'); loadFeed(); }} style={styles.retryBtn}>
          <Text style={styles.retryText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }

  if (status === 'empty') {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>No hay eventos disponibles ahora.</Text>
        <Pressable onPress={() => { setStatus('loading'); loadFeed(); }} style={styles.retryBtn}>
          <Text style={styles.retryText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {status === 'offline' && (
        <View style={styles.offlineBanner}>
          <Text style={styles.offlineText}>
            Sin conexión{cachedAt ? ` · Última carga: ${cachedAt}` : ''}
          </Text>
        </View>
      )}
      <FlatList
        data={items}
        keyExtractor={(item) => item.event_id}
        renderItem={({ item, index }) => {
          const feedIds = items.map((i) => i.event_id).join(',');
          return (
            <View style={{ minHeight: CARD_HEIGHT, justifyContent: 'center' }}>
              <EventCard
                item={item}
                onPress={() => router.push({
                  pathname: '/event/[eventId]',
                  params: { eventId: item.event_id, feedEventIds: feedIds, feedIndex: String(index) },
                })}
                onLongPress={() => handleLongPress(item)}
              />
            </View>
          );
        }}
        snapToAlignment="start"
        decelerationRate="fast"
        pagingEnabled
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        contentContainerStyle={styles.list}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  list: { paddingVertical: spacing.sm },
  errorText: { fontSize: font.md, color: colors.textSecondary, marginBottom: spacing.md },
  emptyText: { fontSize: font.md, color: colors.textSecondary, marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md },
  retryText: { color: '#FFFFFF', fontSize: font.md, fontWeight: '600' },
  offlineBanner: { backgroundColor: colors.warningLight, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  offlineText: { fontSize: font.xs, color: colors.warning, textAlign: 'center', fontWeight: '500' },
});
