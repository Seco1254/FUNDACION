import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  Alert,
  StyleSheet,
} from 'react-native';
import { api } from '../../src/lib/api';
import { storage } from '../../src/lib/storage';
import { colors, spacing, font, radius } from '../../src/lib/theme';
import type { Tab, CustomTopic } from '../../src/lib/types';

const CUSTOM_TOPICS_KEY = 'custom_topics';

export default function TemasScreen() {
  const [serverTabs, setServerTabs] = useState<Tab[]>([]);
  const [customTopics, setCustomTopics] = useState<CustomTopic[]>([]);
  const [newTopic, setNewTopic] = useState('');
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.getTabs();
      setServerTabs(res.items);
    } catch {
      // Keep whatever we have
    }
    const saved = await storage.get<CustomTopic[]>(CUSTOM_TOPICS_KEY);
    if (saved) setCustomTopics(saved);
    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const addTopic = useCallback(async () => {
    const label = newTopic.trim();
    if (!label) return;
    const key = label.toLowerCase().replace(/\s+/g, '_');
    if (customTopics.some((t) => t.key === key)) {
      Alert.alert('Tema duplicado', 'Este tema ya existe.');
      return;
    }
    const updated = [...customTopics, { key, label }];
    setCustomTopics(updated);
    await storage.set(CUSTOM_TOPICS_KEY, updated);
    setNewTopic('');
  }, [newTopic, customTopics]);

  const removeTopic = useCallback(async (key: string) => {
    const updated = customTopics.filter((t) => t.key !== key);
    setCustomTopics(updated);
    await storage.set(CUSTOM_TOPICS_KEY, updated);
  }, [customTopics]);

  return (
    <View style={styles.container}>
      <Text style={styles.sectionTitle}>Temas del servidor</Text>
      {loading ? (
        <Text style={styles.loadingText}>Cargando...</Text>
      ) : (
        <View style={styles.chipContainer}>
          {serverTabs.map((tab) => (
            <View key={tab.key} style={styles.chip}>
              <Text style={styles.chipText}>{tab.label}</Text>
            </View>
          ))}
        </View>
      )}

      <View style={styles.divider} />

      <Text style={styles.sectionTitle}>Mis temas personalizados</Text>
      <View style={styles.addRow}>
        <TextInput
          style={styles.input}
          placeholder="Agregar tema..."
          placeholderTextColor={colors.textMuted}
          value={newTopic}
          onChangeText={setNewTopic}
          onSubmitEditing={addTopic}
          returnKeyType="done"
        />
        <Pressable onPress={addTopic} style={styles.addBtn}>
          <Text style={styles.addBtnText}>+</Text>
        </Pressable>
      </View>

      {customTopics.length === 0 ? (
        <Text style={styles.emptyText}>
          Aún no tienes temas personalizados. Agrega uno arriba.
        </Text>
      ) : (
        <FlatList
          data={customTopics}
          keyExtractor={(item) => item.key}
          renderItem={({ item }) => (
            <View style={styles.topicRow}>
              <Text style={styles.topicLabel}>{item.label}</Text>
              <Pressable onPress={() => removeTopic(item.key)}>
                <Text style={styles.removeBtn}>Eliminar</Text>
              </Pressable>
            </View>
          )}
          style={styles.list}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg, padding: spacing.lg },
  sectionTitle: { fontSize: font.lg, fontWeight: '700', color: colors.text, marginBottom: spacing.md },
  loadingText: { fontSize: font.sm, color: colors.textMuted },
  chipContainer: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.full, borderWidth: 1, borderColor: colors.border },
  chipText: { fontSize: font.sm, color: colors.text, fontWeight: '500' },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xl },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  input: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: font.md, color: colors.text, borderWidth: 1, borderColor: colors.border },
  addBtn: { backgroundColor: colors.primary, width: 44, height: 44, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  addBtnText: { color: '#FFFFFF', fontSize: font.xl, fontWeight: '600' },
  emptyText: { fontSize: font.sm, color: colors.textMuted, fontStyle: 'italic', marginTop: spacing.sm },
  list: { flex: 1 },
  topicRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  topicLabel: { fontSize: font.md, color: colors.text },
  removeBtn: { fontSize: font.sm, color: colors.error, fontWeight: '500' },
});
