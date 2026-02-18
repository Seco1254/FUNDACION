import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet } from 'react-native';
import { api } from '../../src/lib/api';
import { colors, spacing, font, radius } from '../../src/lib/theme';

interface AccordionItem {
  title: string;
  content: string;
}

const METHODOLOGY: AccordionItem[] = [
  {
    title: '¿Cómo se recopilan las noticias?',
    content:
      'Fundación monitorea automáticamente fuentes de noticias colombianas. Los artículos se descubren, normalizan y validan antes de ser agrupados en eventos.',
  },
  {
    title: '¿Cómo se generan los resúmenes?',
    content:
      'Cada evento pasa por un proceso de versionado. Se extraen afirmaciones (claims) y citas textuales. Un generador de resumen construye secciones temáticas con referencias cruzadas.',
  },
  {
    title: '¿Qué son los patrones de sesgo?',
    content:
      'El sistema analiza patrones lingüísticos a nivel de artículo y medio. Los patrones se basan en extracción de características determinísticas (no IA generativa). Pueden ser "No concluyente" cuando la evidencia es limitada.',
  },
  {
    title: '¿Cómo se clasifican los temas?',
    content:
      'Se usa una taxonomía cerrada de 13 categorías más detección de temas emergentes por n-gramas frecuentes.',
  },
  {
    title: '¿Qué son los sub-eventos?',
    content:
      'Son cambios significativos dentro de un evento detectados por deriva temática (cambio de tema dominante) o divergencia de afirmaciones (fuentes reportando cosas distintas).',
  },
];

export default function AcercaDeScreen() {
  const [healthStatus, setHealthStatus] = useState<{ ok: boolean; time: string } | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const checkHealth = useCallback(async () => {
    try {
      const res = await api.getHealth();
      setHealthStatus(res);
      setHealthError(false);
    } catch {
      setHealthError(true);
    }
  }, []);

  useEffect(() => { checkHealth(); }, [checkHealth]);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Acerca de Fundación</Text>
      <Text style={styles.subtitle}>
        Plataforma de monitoreo de noticias con análisis de patrones editoriales.
      </Text>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Metodología</Text>
        {METHODOLOGY.map((item, idx) => (
          <View key={idx} style={styles.accordion}>
            <Pressable
              onPress={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
              style={styles.accordionHeader}
            >
              <Text style={styles.accordionTitle}>{item.title}</Text>
              <Text style={styles.chevron}>{expandedIdx === idx ? '▾' : '▸'}</Text>
            </Pressable>
            {expandedIdx === idx && (
              <Text style={styles.accordionContent}>{item.content}</Text>
            )}
          </View>
        ))}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Estado del sistema</Text>
        <View style={styles.statusCard}>
          {healthError ? (
            <>
              <View style={[styles.statusDot, { backgroundColor: colors.error }]} />
              <Text style={styles.statusText}>No disponible</Text>
              <Pressable onPress={checkHealth}>
                <Text style={styles.retryLink}>Reintentar</Text>
              </Pressable>
            </>
          ) : healthStatus ? (
            <>
              <View style={[styles.statusDot, { backgroundColor: healthStatus.ok ? colors.success : colors.error }]} />
              <Text style={styles.statusText}>
                {healthStatus.ok ? 'Operativo' : 'Con problemas'}
              </Text>
              <Text style={styles.statusTime}>
                {new Date(healthStatus.time).toLocaleString()}
              </Text>
            </>
          ) : (
            <Text style={styles.statusText}>Verificando...</Text>
          )}
        </View>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Fundación v0.1.0 · Los patrones identificados son observaciones automáticas y no constituyen juicios editoriales.
        </Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.xl, paddingBottom: 40 },
  title: { fontSize: font.xxl, fontWeight: '700', color: colors.text },
  subtitle: { fontSize: font.md, color: colors.textSecondary, lineHeight: 22 },
  section: { gap: spacing.md },
  sectionTitle: { fontSize: font.lg, fontWeight: '600', color: colors.text },
  accordion: { backgroundColor: colors.surface, borderRadius: radius.md, overflow: 'hidden' },
  accordionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.lg },
  accordionTitle: { fontSize: font.md, fontWeight: '500', color: colors.text, flex: 1 },
  chevron: { fontSize: font.md, color: colors.textSecondary },
  accordionContent: { fontSize: font.sm, color: colors.textSecondary, lineHeight: 20, paddingHorizontal: spacing.lg, paddingBottom: spacing.lg },
  statusCard: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, backgroundColor: colors.surface, padding: spacing.lg, borderRadius: radius.md },
  statusDot: { width: 10, height: 10, borderRadius: 5 },
  statusText: { fontSize: font.md, color: colors.text, fontWeight: '500' },
  statusTime: { fontSize: font.xs, color: colors.textMuted, marginLeft: 'auto' },
  retryLink: { fontSize: font.sm, color: colors.accent, fontWeight: '500' },
  footer: { paddingTop: spacing.lg },
  footerText: { fontSize: font.xs, color: colors.textMuted, lineHeight: 18, textAlign: 'center' },
});
