import { history } from '../src/lib/history';

// Mock storage
const mockStore: Record<string, string> = {};
jest.mock('../src/lib/storage', () => ({
  storage: {
    get: jest.fn(async (key: string) => {
      const raw = mockStore[key];
      if (!raw) return null;
      return JSON.parse(raw);
    }),
    set: jest.fn(async (key: string, value: any) => {
      mockStore[key] = JSON.stringify(value);
    }),
    remove: jest.fn(async (key: string) => {
      delete mockStore[key];
    }),
  },
}));

beforeEach(() => {
  for (const key of Object.keys(mockStore)) delete mockStore[key];
});

describe('History', () => {
  it('starts empty', async () => {
    const items = await history.getAll();
    expect(items).toEqual([]);
  });

  it('adds events with viewed_at timestamp', async () => {
    await history.add({ event_id: 'e1', headline: 'Test', state: 'PUBLISHED', t_last: null });
    const items = await history.getAll();
    expect(items).toHaveLength(1);
    expect(items[0].event_id).toBe('e1');
    expect(items[0].viewed_at).toBeDefined();
  });

  it('deduplicates by event_id (most recent first)', async () => {
    await history.add({ event_id: 'e1', headline: 'First', state: 'PUBLISHED', t_last: null });
    await history.add({ event_id: 'e2', headline: 'Second', state: 'PUBLISHED', t_last: null });
    await history.add({ event_id: 'e1', headline: 'First Updated', state: 'UPDATING', t_last: null });

    const items = await history.getAll();
    expect(items).toHaveLength(2);
    expect(items[0].event_id).toBe('e1');
    expect(items[0].headline).toBe('First Updated');
    expect(items[1].event_id).toBe('e2');
  });

  it('trims to 200 (FIFO)', async () => {
    for (let i = 0; i < 210; i++) {
      await history.add({ event_id: `e${i}`, headline: `Event ${i}`, state: 'PUBLISHED', t_last: null });
    }
    const items = await history.getAll();
    expect(items).toHaveLength(200);
    // Most recent should be first
    expect(items[0].event_id).toBe('e209');
  });

  it('clears all history', async () => {
    await history.add({ event_id: 'e1', headline: 'Test', state: 'PUBLISHED', t_last: null });
    await history.clear();
    const items = await history.getAll();
    expect(items).toEqual([]);
  });
});
