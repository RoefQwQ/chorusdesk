import { describe, expect, it } from 'vitest';
import { fetchError } from '../src/adapters/types';
import { buildPost } from '../src/adapters/buildPost';
import type { Channel } from '../src/types';
const channel: Channel = {
  id: 'bilibili:42',
  creatorId: 'creator_1',
  platform: 'bilibili',
  accountId: '42',
  displayName: 'tester',
  status: 'idle',
  label: '主账号',
  profileUrl: 'https://space.bilibili.com/42',
};
const base = {
  id: 'bilibili_video_BV1xx',
  title: 't',
  content: 'c',
  mediaList: [],
  originalUrl: 'https://www.bilibili.com/video/BV1xx',
  publishedAt: 1_700_000_000_000,
};

describe('fetchError', () => {
  it('carries exactly the code and the message', () => {
    // It used to carry a third field, `retryable`, that nothing ever read — the
    // sync layer decides on `code` (rate_limit starts a cool-down, not_found means
    // end-of-history). The assertion is on the whole shape on purpose: a field
    // reappearing here should be a deliberate decision, not a quiet addition.
    expect(fetchError('auth', 'x')).toEqual({ code: 'auth', message: 'x' });
  });
});

describe('buildPost', () => {
  it('fills the boilerplate fields from the channel', () => {
    const post = buildPost(channel, { ...base });
    expect(post).toMatchObject({
      id: base.id,
      creatorId: 'creator_1',
      channelId: 'bilibili:42',
      platform: 'bilibili',
      publishedAt: base.publishedAt,
      isRead: 0,
    });
    // fetchedAt is stamped at build time
    expect(post.fetchedAt).toBeGreaterThan(0);
  });

  it('stores 0|1 flags, never booleans (IndexedDB index keys)', () => {
    const post = buildPost(channel, { ...base });
    expect(post.isRead).toBe(0);
    expect(post.isRead).not.toBe(false as unknown);
    expect(post.isBookmarked).toBeUndefined();
  });

  it('writes optional fields only when explicitly passed', () => {
    const plain = buildPost(channel, { ...base });
    expect('isRepost' in plain).toBe(false);
    expect('channelLabel' in plain).toBe(false);

    const repost = buildPost(channel, { ...base, isRepost: true, channelLabel: '里号' });
    expect(repost.isRepost).toBe(true);
    expect(repost.channelLabel).toBe('里号');
  });
});
