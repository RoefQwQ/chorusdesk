import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { notifyBadgeRefresh, __resetBadgeDebounce } from '../src/utils/badge';

/**
 * The REFRESH_BADGE page→SW message chain. The badge used to freeze at a
 * stale count because `updateUnreadBadge` only ran on SW startup and the
 * 30-minute alarm: marking posts read / deleting them / syncing from the
 * dashboard never reached the SW. Pages fire this message after any mutation
 * that changes the unread set; bursts (feed auto-read) coalesce via a
 * trailing debounce so the SW is not messaged once per card.
 */

const sent: Array<Record<string, unknown>> = [];

beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  __resetBadgeDebounce();
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      sendMessage: vi.fn((msg: Record<string, unknown>) => {
        sent.push(msg);
        return Promise.resolve({ success: true });
      }),
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>).chrome;
});

describe('notifyBadgeRefresh', () => {
  it('sends REFRESH_BADGE to the service worker after the debounce', () => {
    notifyBadgeRefresh();
    expect(sent).toEqual([]); // not yet — debounced
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([{ type: 'REFRESH_BADGE' }]);
  });

  it('coalesces a burst of calls into one message', () => {
    // Simulates a feed auto-read burst: many cards fire within one scroll.
    for (let i = 0; i < 20; i++) notifyBadgeRefresh();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([{ type: 'REFRESH_BADGE' }]);
  });

  it('sends again after a later burst (debounce resets)', () => {
    notifyBadgeRefresh();
    vi.advanceTimersByTime(200);
    notifyBadgeRefresh();
    vi.advanceTimersByTime(200);
    expect(sent).toEqual([
      { type: 'REFRESH_BADGE' },
      { type: 'REFRESH_BADGE' },
    ]);
  });

  it('swallows a rejected send (fire-and-forget, never breaks the caller)', () => {
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        sendMessage: vi.fn(() => Promise.reject(new Error('port closed'))),
      },
    };
    expect(() => notifyBadgeRefresh()).not.toThrow();
    vi.advanceTimersByTime(200);
  });

  it('is a no-op when chrome.runtime is unavailable', () => {
    delete (globalThis as Record<string, unknown>).chrome;
    expect(() => {
      notifyBadgeRefresh();
      vi.advanceTimersByTime(200);
    }).not.toThrow();
  });
});
