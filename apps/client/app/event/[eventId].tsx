import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  ScrollView,
  Pressable,
  Modal,
  Linking,
  StyleSheet,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { api, ApiError } from '../../src/lib/api';
import { cache, relativeTime } from '../../src/lib/cache';
import { history } from '../../src/lib/history';
import { ConfidenceBadge } from '../../src/components/ConfidenceBadge';
import { OverviewBlock } from '../../src/components/OverviewBlock';
import { QuoteHighlightCard } from '../../src/components/QuoteHighlightCard';
import { MediaTabHeader } from '../../src/components/MediaTabHeader';
import { TopicHeatmapMini, HeatmapFull } from '../../src/components/TopicHeatmapMini';
import { SubEventTimeline } from '../../src/components/SubEventTimeline';
import { PillTag } from '../../src/components/PillTag';
import { SkeletonCard } from '../../src/components/SkeletonCard';
import { colors, spacing, font, radius } from '../../src/lib/theme';
import type {
  EventDetailResponse,
  MediaTab,
  BiasEndpointResponse,
  BiasLabel,
} from '../../src/lib/types';

type Status = 'loading' | 'error' | 'ok' | 'offline';

export default function EventDetailScreen() {
  const { eventId, feedEventIds: feedEventIdsParam, feedIndex: feedIndexParam } = useLocalSearchParams<{
    eventId: string;
    feedEventIds?: string;
    feedIndex?: string;
  }>();
  const router = useRouter();

  // Peek navigation: list of event IDs from the feed
  const feedEventIds: string[] = feedEventIdsParam ? feedEventIdsParam.split(',') : [];
  const currentIndex = feedIndexParam ? parseInt(feedIndexParam, 10) : -1;
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < feedEventIds.length - 1;

  const [data, setData] = useState<EventDetailResponse | null>(null);
  const [status, setStatus] = useState<Status>('loading');
  const [cachedAt, setCachedAt] = useState<string | null>(null);
  const [selectedMediaKey, setSelectedMediaKey] = useState<string | null>(null);
  const [heatmapModal, setHeatmapModal] = useState(false);
  const [biasModal, setBiasModal] = useState<{ eventId: string; mediaKey: string } | null>(null);
  const [biasData, setBiasData] = useState<BiasEndpointResponse | null>(null);
  const [biasLoading, setBiasLoading] = useState(false);

  // Peek: headlines for prev/next
  const [prevHeadline, setPrevHeadline] = useState<string | null>(null);
  const [nextHeadline, setNextHeadline] = useState<string | null>(null);

  const loadEvent = useCallback(async () => {
    if (!eventId) return;
    if (__DEV__) console.debug(`[detail] fetching event_id=${eventId}`);
    try {
      const result = await api.getEvent(eventId);
      setData(result);
      setStatus('ok');
      setCachedAt(null);
      await cache.setEvent(eventId, result);

      await history.add({
        event_id: eventId,
        headline: result.latest_version?.headline ?? null,
        state: result.event.state,
        t_last: result.event.t_last,
      });
    } catch {
      const cached = await cache.getEvent(eventId);
      if (cached) {
        setData(cached.data);
        setStatus('offline');
        setCachedAt(new Date(cached.timestamp).toLocaleTimeString());
      } else {
        setStatus('error');
      }
    }
  }, [eventId]);

  useEffect(() => { loadEvent(); }, [loadEvent]);

  // Load peek headlines from cache
  useEffect(() => {
    (async () => {
      if (hasPrev) {
        const prevId = feedEventIds[currentIndex - 1];
        const c = await cache.getEvent(prevId);
        setPrevHeadline(c?.data.latest_version?.headline ?? null);
      }
      if (hasNext) {
        const nextId = feedEventIds[currentIndex + 1];
        const c = await cache.getEvent(nextId);
        setNextHeadline(c?.data.latest_version?.headline ?? null);
      }
    })();
  }, [feedEventIds, currentIndex, hasPrev, hasNext]);

  const navigateTo = useCallback((idx: number) => {
    const eid = feedEventIds[idx];
    if (!eid) return;
    router.replace({
      pathname: '/event/[eventId]',
      params: {
        eventId: eid,
        feedEventIds: feedEventIds.join(','),
        feedIndex: String(idx),
      },
    });
  }, [feedEventIds, router]);

  // Swipe navigation: detect boundary drags to navigate between events
  const scrollY = useRef(0);
  const handleScrollEndDrag = useCallback(
    ({ nativeEvent }: { nativeEvent: { contentOffset: { y: number }; velocity?: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
      const { contentOffset, velocity, contentSize, layoutMeasurement } = nativeEvent;
      const atTop = contentOffset.y < 5;
      const maxScroll = contentSize.height - layoutMeasurement.height;
      const atBottom = maxScroll <= 0 || contentOffset.y > maxScroll - 5;
      const vy = velocity?.y ?? 0;
      if (atTop && vy > 0.1 && hasPrev) {
        navigateTo(currentIndex - 1);
      } else if (atBottom && vy < -0.1 && hasNext) {
        navigateTo(currentIndex + 1);
      }
    },
    [hasPrev, hasNext, currentIndex, navigateTo],
  );

  const loadBias = useCallback(async (mediaKey: string) => {
    if (!eventId) return;
    setBiasLoading(true);
    try {
      const result = await api.getBias(eventId, mediaKey);
      setBiasData(result);
      await cache.setBias(eventId, mediaKey, result);
    } catch {
      const cached = await cache.getBias(eventId, mediaKey);
      if (cached) setBiasData(cached.data);
    }
    setBiasLoading(false);
  }, [eventId]);

  const openBiasModal = useCallback((mediaKey: string) => {
    if (!eventId) return;
    setBiasModal({ eventId, mediaKey });
    setBiasData(null);
    loadBias(mediaKey);
  }, [eventId, loadBias]);

  if (status === 'loading') {
    return <View style={styles.container}><SkeletonCard /><SkeletonCard /></View>;
  }

  if (status === 'error' || !data) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>No pudimos cargar el evento.</Text>
        <Pressable onPress={() => { setStatus('loading'); loadEvent(); }} style={styles.retryBtn}>
          <Text style={styles.retryText}>Reintentar</Text>
        </Pressable>
      </View>
    );
  }

  const { event, latest_version, media_tabs, overview, topics, topics_heatmap, subevents } = data;
  const selectedTab = selectedMediaKey
    ? media_tabs.find((t) => t.media_key === selectedMediaKey)
    : null;

  const selectedMediaBias = selectedMediaKey
    ? data.bias.media_level.find((b) => {
        const tab = media_tabs.find((t) => t.media_key === selectedMediaKey);
        return tab && b.media_id;
      }) ?? data.bias.media_level[0]
    : null;

  // Extract confidence_label from packet_json ai_overview
  const aiOverview = (latest_version?.packet_json as any)?.ai_overview;
  const confidenceLabel: string | null = aiOverview?.confidence_label ?? null;

  return (
    <View style={styles.container}>
      {/* Peek bar: previous event */}
      {hasPrev && (
        <Pressable onPress={() => navigateTo(currentIndex - 1)} style={styles.peekBarTop}>
          <Text style={styles.peekArrow}>▲</Text>
          <Text style={styles.peekText} numberOfLines={1}>
            Anterior: {prevHeadline ?? 'Evento anterior'}
          </Text>
        </Pressable>
      )}

      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.scrollContent}
        scrollEventThrottle={16}
        onScroll={({ nativeEvent }) => { scrollY.current = nativeEvent.contentOffset.y; }}
        onScrollEndDrag={handleScrollEndDrag}
      >
        {status === 'offline' && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineText}>
              Sin conexión{cachedAt ? ` · ${cachedAt}` : ''}
            </Text>
          </View>
        )}

        {/* Header */}
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <PillTag state={event.state} />
            <ConfidenceBadge gateStatus={latest_version?.gate_status} />
          </View>
          <Text style={styles.headline}>
            {latest_version?.headline ?? 'Evento en desarrollo...'}
          </Text>
          <View style={styles.metaRow}>
            {media_tabs.length > 0 && (
              <Text style={styles.metaText}>
                {media_tabs.length} fuente{media_tabs.length !== 1 ? 's' : ''}
              </Text>
            )}
            {event.t_last && (
              <Text style={styles.metaText}>
                Actualizado {relativeTime(event.t_last)}
              </Text>
            )}
          </View>
        </View>

        {/* Overview — structured sections */}
        <View style={styles.section}>
          <View style={styles.overviewHeader}>
            <Text style={styles.sectionTitle}>Resumen (IA)</Text>
            {confidenceLabel && (
              <View style={styles.confidenceBadge}>
                <Text style={styles.confidenceText}>{confidenceLabel}</Text>
              </View>
            )}
          </View>
          <OverviewBlock overview={overview} onRetry={loadEvent} />
        </View>

        {/* Heatmap mini */}
        {topics_heatmap.length > 0 && (
          <View style={styles.section}>
            <TopicHeatmapMini bins={topics_heatmap} onViewFull={() => setHeatmapModal(true)} />
          </View>
        )}

        {/* Sub-events */}
        {subevents.length > 0 && (
          <View style={styles.section}>
            <SubEventTimeline subevents={subevents} />
          </View>
        )}

        {/* Media Tabs */}
        {media_tabs.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Fuentes</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabScroll}>
              <Pressable
                onPress={() => setSelectedMediaKey(null)}
                style={[styles.tabBtn, !selectedMediaKey && styles.tabBtnActive]}
              >
                <Text style={[styles.tabBtnText, !selectedMediaKey && styles.tabBtnTextActive]}>
                  Resumen
                </Text>
              </Pressable>
              {media_tabs.map((tab) => (
                <Pressable
                  key={tab.media_key}
                  onPress={() => setSelectedMediaKey(tab.media_key)}
                  style={[styles.tabBtn, selectedMediaKey === tab.media_key && styles.tabBtnActive]}
                >
                  <Text style={[styles.tabBtnText, selectedMediaKey === tab.media_key && styles.tabBtnTextActive]}>
                    {tab.media_key}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>

            {selectedTab ? (
              <MediaTabContent
                tab={selectedTab}
                biasLabel={selectedMediaBias}
                onOpenBias={() => openBiasModal(selectedTab.media_key)}
              />
            ) : (
              <MediaSummary tabs={media_tabs} onSelectMedia={setSelectedMediaKey} />
            )}
          </View>
        )}

        {/* Heatmap full modal */}
        <Modal visible={heatmapModal} animationType="slide" presentationStyle="pageSheet">
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Mapa de calor</Text>
              <Pressable onPress={() => setHeatmapModal(false)}>
                <Text style={styles.modalClose}>Cerrar</Text>
              </Pressable>
            </View>
            <HeatmapFull bins={topics_heatmap} />
          </View>
        </Modal>

        {/* Bias rationale modal */}
        <Modal visible={!!biasModal} animationType="slide" presentationStyle="pageSheet">
          <View style={styles.modalContainer}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>¿Por qué esta etiqueta?</Text>
              <Pressable onPress={() => { setBiasModal(null); setBiasData(null); }}>
                <Text style={styles.modalClose}>Cerrar</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.biasContent}>
              {biasLoading ? (
                <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: spacing.xl }} />
              ) : biasData ? (
                <BiasRationaleContent data={biasData} />
              ) : (
                <Text style={styles.biasEmpty}>No se pudo cargar el análisis.</Text>
              )}
            </ScrollView>
          </View>
        </Modal>
      </ScrollView>

      {/* Peek bar: next event */}
      {hasNext && (
        <Pressable onPress={() => navigateTo(currentIndex + 1)} style={styles.peekBarBottom}>
          <Text style={styles.peekText} numberOfLines={1}>
            Siguiente: {nextHeadline ?? 'Próximo evento'}
          </Text>
          <Text style={styles.peekArrow}>▼</Text>
        </Pressable>
      )}
    </View>
  );
}

// ── Media Tab Content ──

function MediaTabContent({ tab, biasLabel, onOpenBias }: {
  tab: MediaTab;
  biasLabel: BiasLabel | null | undefined;
  onOpenBias: () => void;
}) {
  const biasLabelText = biasLabel?.label_primary ?? null;
  const showBiasMenu = biasLabel && biasLabel.label_primary !== 'INCONCLUSO';

  return (
    <View style={styles.mediaContent}>
      <View style={styles.mediaHeaderRow}>
        <MediaTabHeader
          mediaKey={tab.media_key}
          biasLabel={biasLabelText ? formatBiasLabel(biasLabelText) : null}
        />
        {showBiasMenu && (
          <Pressable onPress={onOpenBias} style={styles.biasMenuBtn}>
            <Text style={styles.biasMenuText}>¿Por qué?</Text>
          </Pressable>
        )}
      </View>

      {tab.highlights.length > 0 && (
        <View style={styles.highlightsSection}>
          <Text style={styles.highlightsTitle}>Citas destacadas</Text>
          {tab.highlights.map((q) => (
            <QuoteHighlightCard key={q.quote_id} quote={q} />
          ))}
        </View>
      )}

      <View style={styles.articlesSection}>
        <Text style={styles.articlesTitle}>Extractos</Text>
        <Text style={styles.microcopy}>
          Lee el artículo completo en la fuente.
        </Text>
        {tab.articles.map((article) => (
          <View key={article.article_id} style={styles.articleCard}>
            <Text style={styles.articleTitle} numberOfLines={2}>{article.title}</Text>
            <Text style={styles.articleSnippet} numberOfLines={3}>{article.snippet}</Text>
            <Pressable
              onPress={() => { if (article.url) Linking.openURL(article.url); }}
              style={styles.openSourceBtn}
            >
              <Text style={styles.openSourceText}>Abrir en la fuente</Text>
            </Pressable>
          </View>
        ))}
      </View>
    </View>
  );
}

// ── Media Summary ──

function MediaSummary({ tabs, onSelectMedia }: {
  tabs: MediaTab[];
  onSelectMedia: (key: string) => void;
}) {
  return (
    <View style={styles.mediaSummary}>
      <Text style={styles.mediaSummaryTitle}>Resumen por fuentes</Text>
      {tabs.map((tab) => (
        <Pressable
          key={tab.media_key}
          onPress={() => onSelectMedia(tab.media_key)}
          style={styles.mediaSummaryRow}
        >
          <MediaTabHeader mediaKey={tab.media_key} />
          <Text style={styles.mediaSummaryCount}>
            {tab.articles.length} artículo{tab.articles.length !== 1 ? 's' : ''}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

// ── Bias Rationale Content ──

function BiasRationaleContent({ data }: { data: BiasEndpointResponse }) {
  const ml = data.media_level;

  return (
    <View style={styles.biasRationale}>
      {ml ? (
        <>
          <View style={styles.biasLabelRow}>
            <Text style={styles.biasLabelPrimary}>
              Patrón: {formatBiasLabel(ml.label_primary)}
            </Text>
            {ml.confidence < 0.5 && (
              <Text style={styles.biasLowConfidence}>Evidencia limitada</Text>
            )}
          </View>

          {ml.rationale && (
            <>
              <Text style={styles.biasWhy}>{ml.rationale.why_short}</Text>

              {ml.rationale.why_signals.length > 0 && (
                <View style={styles.biasSignals}>
                  <Text style={styles.biasSignalsTitle}>Señales detectadas:</Text>
                  {ml.rationale.why_signals.map((s, i) => (
                    <Text key={i} style={styles.biasSignalItem}>• {s}</Text>
                  ))}
                </View>
              )}

              {ml.rationale.why_quotes.length > 0 && (
                <View style={styles.biasQuotes}>
                  <Text style={styles.biasQuotesTitle}>Extractos relevantes:</Text>
                  {ml.rationale.why_quotes.slice(0, 2).map((q, i) => (
                    <Text key={i} style={styles.biasQuoteItem}>"{q}"</Text>
                  ))}
                </View>
              )}
            </>
          )}
        </>
      ) : (
        <Text style={styles.biasEmpty}>Sin datos de análisis para esta fuente.</Text>
      )}

      {data.article_level.length > 0 && (
        <View style={styles.biasArticles}>
          <Text style={styles.biasArticlesTitle}>Por artículo:</Text>
          {data.article_level.map((a, i) => (
            <View key={i} style={styles.biasArticleRow}>
              <Text style={styles.biasArticleLabel}>
                {formatBiasLabel(a.label_primary)}
              </Text>
              {a.rationale?.why_short && (
                <Text style={styles.biasArticleWhy}>{a.rationale.why_short}</Text>
              )}
            </View>
          ))}
        </View>
      )}

      <View style={styles.disclaimer}>
        <Text style={styles.disclaimerText}>
          Este análisis es una observación automática basada en patrones lingüísticos.
          No constituye un juicio editorial ni una acusación. Los resultados pueden ser
          "No concluyente" cuando la evidencia es insuficiente.
        </Text>
      </View>
    </View>
  );
}

function formatBiasLabel(label: string): string {
  const map: Record<string, string> = {
    CRITICO: 'Crítico',
    EMOCIONAL: 'Emocional',
    NEUTRO: 'Neutro',
    INSTITUCIONAL: 'Institucional',
    PRO_GOBIERNO: 'Pro gobierno',
    ANTI_GOBIERNO: 'Anti gobierno',
    INCONCLUSO: 'No concluyente',
  };
  return map[label] ?? label;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  scrollView: { flex: 1 },
  scrollContent: { paddingBottom: 40 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  errorText: { fontSize: font.md, color: colors.textSecondary, marginBottom: spacing.md },
  retryBtn: { backgroundColor: colors.primary, paddingHorizontal: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md },
  retryText: { color: '#FFFFFF', fontSize: font.md, fontWeight: '600' },
  offlineBanner: { backgroundColor: colors.warningLight, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm },
  offlineText: { fontSize: font.xs, color: colors.warning, textAlign: 'center', fontWeight: '500' },

  // Peek bars
  peekBarTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  peekBarBottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    backgroundColor: colors.surfaceAlt,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  peekArrow: {
    fontSize: font.xs,
    color: colors.accent,
    fontWeight: '700',
  },
  peekText: {
    flex: 1,
    fontSize: font.sm,
    color: colors.accent,
    fontWeight: '500',
  },

  // Header
  header: { padding: spacing.lg, gap: spacing.sm },
  headerRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  headline: { fontSize: font.xxl, fontWeight: '700', color: colors.text, lineHeight: 32 },
  metaRow: { flexDirection: 'row', gap: spacing.md },
  metaText: { fontSize: font.xs, color: colors.textMuted },

  // Sections
  section: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border },
  sectionTitle: { fontSize: font.lg, fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  overviewHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.sm },
  confidenceBadge: {
    backgroundColor: colors.surfaceAlt,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
  confidenceText: {
    fontSize: font.xs,
    fontWeight: '500',
    color: colors.textSecondary,
  },

  // Media tabs
  tabScroll: { marginBottom: spacing.md },
  tabBtn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderRadius: radius.full, backgroundColor: colors.surfaceAlt, marginRight: spacing.sm },
  tabBtnActive: { backgroundColor: colors.primary },
  tabBtnText: { fontSize: font.sm, fontWeight: '500', color: colors.textSecondary },
  tabBtnTextActive: { color: '#FFFFFF' },

  // Media content
  mediaContent: { gap: spacing.md },
  mediaHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  biasMenuBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  biasMenuText: { fontSize: font.sm, color: colors.accent, fontWeight: '500' },
  highlightsSection: { gap: spacing.sm },
  highlightsTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  articlesSection: { gap: spacing.sm },
  articlesTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  microcopy: { fontSize: font.xs, color: colors.textMuted, fontStyle: 'italic' },
  articleCard: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, gap: spacing.xs },
  articleTitle: { fontSize: font.md, fontWeight: '600', color: colors.text },
  articleSnippet: { fontSize: font.sm, color: colors.textSecondary, lineHeight: 20 },
  openSourceBtn: { alignSelf: 'flex-start', marginTop: spacing.xs },
  openSourceText: { fontSize: font.xs, color: colors.accent, fontWeight: '500' },

  // Media summary
  mediaSummary: { gap: spacing.sm },
  mediaSummaryTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  mediaSummaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.xs },
  mediaSummaryCount: { fontSize: font.xs, color: colors.textMuted },

  // Modal
  modalContainer: { flex: 1, backgroundColor: colors.bg },
  modalHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  modalTitle: { fontSize: font.lg, fontWeight: '600', color: colors.text },
  modalClose: { fontSize: font.md, color: colors.accent, fontWeight: '500' },

  // Bias modal
  biasContent: { padding: spacing.lg },
  biasRationale: { gap: spacing.md },
  biasLabelRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
  biasLabelPrimary: { fontSize: font.lg, fontWeight: '600', color: colors.text },
  biasLowConfidence: { fontSize: font.xs, color: colors.warning, fontWeight: '500', backgroundColor: colors.warningLight, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.full },
  biasWhy: { fontSize: font.md, color: colors.textSecondary, lineHeight: 22 },
  biasSignals: { gap: spacing.xs },
  biasSignalsTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  biasSignalItem: { fontSize: font.sm, color: colors.textSecondary, paddingLeft: spacing.sm },
  biasQuotes: { gap: spacing.xs },
  biasQuotesTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  biasQuoteItem: { fontSize: font.sm, color: colors.textSecondary, fontStyle: 'italic', paddingLeft: spacing.sm },
  biasArticles: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border, paddingTop: spacing.md },
  biasArticlesTitle: { fontSize: font.sm, fontWeight: '600', color: colors.text },
  biasArticleRow: { gap: 2 },
  biasArticleLabel: { fontSize: font.sm, fontWeight: '500', color: colors.text },
  biasArticleWhy: { fontSize: font.xs, color: colors.textMuted },
  biasEmpty: { fontSize: font.md, color: colors.textMuted, textAlign: 'center', padding: spacing.xl },
  disclaimer: { backgroundColor: colors.surfaceAlt, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  disclaimerText: { fontSize: font.xs, color: colors.textMuted, lineHeight: 18, textAlign: 'center' },
});
