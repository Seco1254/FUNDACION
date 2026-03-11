import React, { useCallback, useEffect, useState, useRef, useMemo } from 'react';
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
  ViewToken,
} from 'react-native';
import { useRouter } from 'expo-router';
import { api } from '../../src/lib/api';
import { cache } from '../../src/lib/cache';
import { EventCard } from '../../src/components/EventCard';
import { SkeletonCard } from '../../src/components/SkeletonCard';
import { colors, spacing, font, radius } from '../../src/lib/theme';
import type { FeedItem } from '../../src/lib/types';

const { height: SCREEN_HEIGHT } = Dimensions.get('window');
// Smaller card height to reveal peek of prev/next cards
const PEEK_HEIGHT = 40;
const CARD_HEIGHT = Math.round(SCREEN_HEIGHT * 0.68);
const CARD_GAP = spacing.md;
const SNAP_INTERVAL = CARD_HEIGHT + CARD_GAP;

type Status = 'loading' | 'error' | 'empty' | 'ok' | 'offline';

const OVERVIEW_POLL_INTERVAL = 5_000;
const OVERVIEW_POLL_MAX = 6; // 30 seconds total

export default function ForYouScreen() {
  const router = useRouter();
  const [items, setItems] = useState<FeedItem[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCountRef = useRef(0);
  const flatListRef = useRef<FlatList>(null);

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
    } catch {
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

  // Poll for overview on active item if missing
  useEffect(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    pollCountRef.current = 0;

    const activeItem = items[activeIndex];
    if (!activeItem) return;

    const ov = activeItem.ai_overview;
    const hasOverview = ov && (ov.what_happened.length > 0 || ov.context.length > 0);
    if (hasOverview) return;

    // Don't poll if backend explicitly says overview is unavailable (gate blocked)
    if (activeItem.overview_status === 'unavailable') return;

    function poll() {
      if (pollCountRef.current >= OVERVIEW_POLL_MAX) return;
      pollCountRef.current++;
      pollTimerRef.current = setTimeout(async () => {
        try {
          const data = await api.getFeed();
          const updated = data.items.find((i) => i.event_id === activeItem.event_id);
          if (updated?.ai_overview) {
            setItems((prev) =>
              prev.map((it) => it.event_id === updated.event_id ? { ...it, ai_overview: updated.ai_overview, overview_status: updated.overview_status } : it),
            );
            return; // stop polling
          }
        } catch { /* ignore, retry next interval */ }
        poll();
      }, OVERVIEW_POLL_INTERVAL);
    }
    poll();

    return () => {
      if (pollTimerRef.current) {
        clearTimeout(pollTimerRef.current);
        pollTimerRef.current = null;
      }
    };
  }, [activeIndex, items]);

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

  const handleRetryOverview = useCallback(async () => {
    pollCountRef.current = 0;
    try {
      const data = await api.getFeed();
      setItems(data.items);
      setNextCursor(data.next_cursor);
    } catch { /* ignore */ }
  }, []);

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
      Alert.alert('Opciones', undefined, [
        { text: 'Compartir', onPress: () => Alert.alert('Enlace no disponible por ahora.') },
        { text: 'Ver metodología', onPress: () => router.push('/(tabs)/acerca') },
        { text: 'Cancelar', style: 'cancel' },
      ]);
    }
  }, [router]);

  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: ViewToken[] }) => {
    if (viewableItems.length > 0 && viewableItems[0].index != null) {
      setActiveIndex(viewableItems[0].index);
    }
  }).current;

  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 60 }).current;

  // Stable comma-joined ID list for navigation — recomputed only when items change.
  // MUST be declared before any conditional returns so hooks always execute in the same order.
  const feedIds = useMemo(() => items.map((i) => i.event_id).join(','), [items]);

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
        ref={flatListRef}
        data={items}
        keyExtractor={(item) => item.event_id}
        renderItem={({ item, index }) => (
          <View style={styles.cardWrapper}>
            <EventCard
              item={item}
              onPress={() => router.push({
                pathname: '/event/[eventId]',
                params: { eventId: item.event_id, feedEventIds: feedIds, feedIndex: String(index) },
              })}
              onLongPress={() => handleLongPress(item)}
              onRetryOverview={handleRetryOverview}
            />
          </View>
        )}
        snapToInterval={SNAP_INTERVAL}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={handleRefresh} tintColor={colors.primary} />
        }
        onEndReached={handleLoadMore}
        onEndReachedThreshold={0.5}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={viewabilityConfig}
        contentContainerStyle={styles.list}
        getItemLayout={(_data, index) => ({
          length: SNAP_INTERVAL,
          offset: SNAP_INTERVAL * index,
          index,
        })}
      />
      {/* Page indicator */}
      {items.length > 1 && (
        <View style={styles.pageIndicator}>
          <Text style={styles.pageText}>{activeIndex + 1} / {items.length}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  list: { paddingTop: PEEK_HEIGHT / 2, paddingBottom: PEEK_HEIGHT },
  cardWrapper: {
    height: CARD_HEIGHT,
    marginBottom: CARD_GAP,
    justifyContent: 'center',
  },
  errorText: { fontSize: font.md, color: colors.textSecondary, marginBottom: spacing.md },
  emptyText: { fontSize: font.md, color: colors.textSecondary, marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md },
  retryText: { color: '#FFFFFF', fontSize: font.md, fontWeight: '600' },
  offlineBanner: { backgroundColor: colors.warningLight, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  offlineText: { fontSize: font.xs, color: colors.warning, textAlign: 'center', fontWeight: '500' },
  pageIndicator: {
    position: 'absolute',
    bottom: spacing.lg,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  pageText: { color: '#FFFFFF', fontSize: font.xs, fontWeight: '600' },
});
