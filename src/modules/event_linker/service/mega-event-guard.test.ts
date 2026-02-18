import { describe, it, expect } from 'vitest';
import { checkMegaEvent, MAX_ARTICLES_PER_EVENT, MAX_SUBEVENTS } from './mega-event-guard.js';

describe('checkMegaEvent', () => {
  it('returns not mega for normal event', () => {
    const result = checkMegaEvent({
      eventId: 'evt-1',
      articleCount: 5,
      subEventCount: 2,
    });
    expect(result.isMega).toBe(false);
    expect(result.reason).toBeNull();
  });

  it('flags event with too many articles', () => {
    const result = checkMegaEvent({
      eventId: 'evt-big',
      articleCount: MAX_ARTICLES_PER_EVENT + 1,
      subEventCount: 0,
    });
    expect(result.isMega).toBe(true);
    expect(result.reason).toContain('article_count');
  });

  it('flags event at exactly threshold + 1 articles', () => {
    const result = checkMegaEvent({
      eventId: 'evt-edge',
      articleCount: 26,
      subEventCount: 0,
    });
    expect(result.isMega).toBe(true);
  });

  it('does not flag event at exactly threshold articles', () => {
    const result = checkMegaEvent({
      eventId: 'evt-exact',
      articleCount: 25,
      subEventCount: 0,
    });
    expect(result.isMega).toBe(false);
  });

  it('flags event with too many sub-events', () => {
    const result = checkMegaEvent({
      eventId: 'evt-sub',
      articleCount: 10,
      subEventCount: MAX_SUBEVENTS + 1,
    });
    expect(result.isMega).toBe(true);
    expect(result.reason).toContain('sub_event_count');
  });

  it('article limit takes priority over sub-event check', () => {
    const result = checkMegaEvent({
      eventId: 'evt-both',
      articleCount: 30,
      subEventCount: 10,
    });
    expect(result.isMega).toBe(true);
    expect(result.reason).toContain('article_count');
  });
});
