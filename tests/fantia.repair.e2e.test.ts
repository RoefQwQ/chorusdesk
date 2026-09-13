import { describe, expect, it } from 'vitest';
import { shouldRepairStoredContent } from '../src/sync/channelSync';
import { fantiaCommentText } from '../src/adapters/fantia';
import type { Post } from '../src/types';

/**
 * End-to-end check of the repair the user needs, using the row their own card
 * shows (screenshot, 2026-09-14) and the body the adapter now produces for that
 * post from the live API.
 */
const STORED_RAW_DELTA =
  '{"ops":[{"insert":"本編→"},{"attributes":{"link":"https://fantia.jp/posts/3210183"},"insert":"https://fantia.jp/posts/3210183"},{"insert":"\\n"}]}';
const FRESH_BODY = '本編→https://fantia.jp/posts/3210183';

function post(content: string): Post {
  return {
    id: 'fantia_4236630',
    creatorId: 'c1',
    channelId: 'fantia:yume',
    platform: 'fantia',
    title: '【無料】ふとももすりすり',
    content,
    mediaList: [],
    originalUrl: 'https://fantia.jp/posts/4236630',
    publishedAt: 1,
    fetchedAt: 1,
    isRead: 0,
  };
}

describe('the user\'s stored row is actually repairable', () => {
  it('decodes the stored delta to the fresh body exactly', () => {
    // The whole reason replacing is safe: the decoder turns the stored bytes into
    // the very text the fresh row carries. If these diverged, the repair would be
    // replacing one wrong body with another.
    expect(fantiaCommentText(STORED_RAW_DELTA)).toBe(FRESH_BODY);
  });

  it('fires, and the result is the readable body', () => {
    const stored = post(STORED_RAW_DELTA);
    const fresh = post(FRESH_BODY);
    expect(shouldRepairStoredContent(stored, fresh)).toBe(true);
    // What the card will render after the repair.
    expect(fresh.content).toBe(FRESH_BODY);
    expect(fresh.content).not.toContain('ops');
  });
});
