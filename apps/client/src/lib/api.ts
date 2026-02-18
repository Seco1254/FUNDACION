import Constants from 'expo-constants';
import type {
  FeedResponse,
  EventDetailResponse,
  BiasEndpointResponse,
  TabsResponse,
  HealthResponse,
} from './types';

const BASE_URL =
  Constants.expoConfig?.extra?.apiBaseUrl ??
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  'http://localhost:3000';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, etag?: string): Promise<{ data: T; status: number; etag?: string }> {
  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };
  if (etag) {
    headers['If-None-Match'] = etag;
  }

  const res = await fetch(`${BASE_URL}${path}`, { headers });

  if (res.status === 304) {
    return { data: undefined as unknown as T, status: 304, etag };
  }

  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new ApiError(429, { retry_after_seconds: retryAfter ? parseInt(retryAfter, 10) : 60 });
  }

  if (!res.ok) {
    let body: unknown;
    try { body = await res.json(); } catch { body = await res.text(); }
    throw new ApiError(res.status, body);
  }

  const data = (await res.json()) as T;
  const responseEtag = res.headers.get('etag') ?? undefined;
  return { data, status: res.status, etag: responseEtag };
}

export const api = {
  async getFeed(cursor?: string): Promise<FeedResponse> {
    const params = new URLSearchParams();
    if (cursor) params.set('cursor', cursor);
    const query = params.toString();
    const path = `/v1/feed${query ? `?${query}` : ''}`;
    const { data } = await request<FeedResponse>(path);
    return data;
  },

  async getEvent(eventId: string): Promise<EventDetailResponse> {
    const { data } = await request<EventDetailResponse>(`/v1/events/${eventId}`);
    return data;
  },

  async getBias(eventId: string, mediaKey: string): Promise<BiasEndpointResponse> {
    const { data } = await request<BiasEndpointResponse>(`/v1/events/${eventId}/bias/${mediaKey}`);
    return data;
  },

  async getTabs(): Promise<TabsResponse> {
    const { data } = await request<TabsResponse>('/v1/tabs');
    return data;
  },

  async getHealth(): Promise<HealthResponse> {
    const { data } = await request<HealthResponse>('/v1/health');
    return data;
  },
};
