import { Platform } from 'react-native';

/**
 * Cross-platform storage abstraction.
 * Uses AsyncStorage on mobile, localStorage on web.
 */

let AsyncStorageModule: any = null;

async function getAsyncStorage() {
  if (AsyncStorageModule) return AsyncStorageModule;
  if (Platform.OS === 'web') {
    // Web: use localStorage wrapper
    AsyncStorageModule = {
      getItem: async (key: string) => {
        try { return localStorage.getItem(key); } catch { return null; }
      },
      setItem: async (key: string, value: string) => {
        try { localStorage.setItem(key, value); } catch { /* noop */ }
      },
      removeItem: async (key: string) => {
        try { localStorage.removeItem(key); } catch { /* noop */ }
      },
    };
  } else {
    const mod = await import('@react-native-async-storage/async-storage');
    AsyncStorageModule = mod.default;
  }
  return AsyncStorageModule;
}

export const storage = {
  async get<T>(key: string): Promise<T | null> {
    const store = await getAsyncStorage();
    const raw = await store.getItem(key);
    if (raw === null) return null;
    try { return JSON.parse(raw) as T; } catch { return null; }
  },

  async set<T>(key: string, value: T): Promise<void> {
    const store = await getAsyncStorage();
    await store.setItem(key, JSON.stringify(value));
  },

  async remove(key: string): Promise<void> {
    const store = await getAsyncStorage();
    await store.removeItem(key);
  },
};
