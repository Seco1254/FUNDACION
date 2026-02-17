import { FetchHtml } from '../domain/types.js';
import { FETCH_TIMEOUT_MS, USER_AGENT } from './constants.js';

export const productionFetchHtml: FetchHtml = async (url: string): Promise<string> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeout);
  }
};
