import { beforeEach, describe, expect, it, vi } from 'vitest';
import { douyinAdapter } from '../src/adapters/douyin';
import type { Channel } from '../src/types';
import { videoSnapshot } from './fixtures/douyin/snapshots';

/**
 * Adapter-level behaviour of a Douyin history dig.
 *
 * Background: the creator page does not scroll the window — the grid lives in
 * `.route-scroll-container`, whose own scrollTop drives the lazy loader. The V1
 * spike scrolled the window, saw no growth and concluded Douyin had no usable
 * pagination, so history was declared unsupported. Re-probing showed the real
 * limit is different: scrolling the right container does load more, but anonymous
 * browsing stops partway down the grid (measured 18 of a stated 29 works).
 *
 * The contract that follows from that:
 *   - a dig asks the page to scroll (`deep: true`) and takes the whole payload;
 *   - a grid short of `statedTotal` is NOT reported as end-of-history, so the
 *     user can finish the dig after logging in;
 *   - when such a dig yields nothing new, the reason is an explicit `auth` error
 *     naming the shortfall, never a silent "0 new posts".
 */

const channel: Channel = {
  id: 'douyin:hist',
  creatorId: 'creator_hist',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  displayName: '示例创作者',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
};

/** Capture the outgoing message and reply with a canned snapshot. */
function stubChannel(snapshot: unknown) {
  const sent: Record<string, unknown>[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    runtime: {
      lastError: undefined,
      id: 'test-extension',
      sendMessage: (msg: Record<string, unknown>, cb: (r: unknown) => void) => {
        sent.push(msg);
        cb({ success: true, snapshot });
      },
    },
  };
  return sent;
}

describe('douyin history dig', () => {
  beforeEach(() => {
    delete (globalThis as Record<string, unknown>).chrome;
    vi.restoreAllMocks();
  });

  it('asks the page to scroll when digging history', async () => {
    const sent = stubChannel({ ...videoSnapshot, statedTotal: 3 });
    await douyinAdapter.fetchLatest(channel, 10, { isHistory: true });
    expect(sent[0]).toMatchObject({ type: 'FETCH_DOUYIN_SNAPSHOT', deep: true });
    // A dig takes the whole scrolled payload, not one page's worth.
    expect(Number(sent[0].limit)).toBeGreaterThan(10);
  });

  it('does not scroll for a plain latest sync', async () => {
    const sent = stubChannel(videoSnapshot);
    await douyinAdapter.fetchLatest(channel, 10);
    expect(sent[0]).toMatchObject({ deep: false, limit: 10 });
  });

  it('scrolls for a cursor page and a force refresh too', async () => {
    const cursorSent = stubChannel(videoSnapshot);
    await douyinAdapter.fetchLatest(channel, 10, { cursor: '0' });
    expect(cursorSent[0]).toMatchObject({ deep: true });

    const forceSent = stubChannel(videoSnapshot);
    await douyinAdapter.fetchLatest(channel, 10, { forceRefresh: true });
    expect(forceSent[0]).toMatchObject({ deep: true });
  });

  it('claims end-of-history only when the grid looks complete', async () => {
    // 3 fixture works, header states 3 → nothing is being withheld.
    stubChannel({ ...videoSnapshot, statedTotal: 3, saturated: true });
    const res = await douyinAdapter.fetchLatest(channel, 50, { isHistory: true });
    expect(res.hasMore).toBe(false);
    expect(res.error).toBeUndefined();
  });

  it('keeps a login-truncated dig resumable instead of parking it at the end', async () => {
    // 3 works loaded, header states 29 → the rest sit behind the login wall.
    // hasMore must NOT be false: channelSync would write __END__ and the user
    // could never dig the remainder after logging in.
    stubChannel({ ...videoSnapshot, statedTotal: 29, saturated: true });
    const res = await douyinAdapter.fetchLatest(channel, 50, { isHistory: true });
    expect(res.hasMore).not.toBe(false);
  });

  it('explains a truncated dig that found nothing, rather than reporting success', async () => {
    stubChannel({ ...videoSnapshot, statedTotal: 29, saturated: true });
    // Watermark at the newest work: the dig discovers no new posts, and the only
    // honest explanation is the login-gated shortfall.
    const newest = Math.max(
      ...videoSnapshot.items.map((i) => Number(BigInt(i.awemeId) >> 32n) * 1000),
    );
    const res = await douyinAdapter.fetchLatest(channel, 50, {
      isHistory: true,
      sinceTimestamp: newest,
    });
    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('auth');
    expect(res.error?.message).toContain('29');
    expect(res.error?.message).toContain('登录');
    // Must not double as an end-of-history signal.
    expect(res.hasMore).not.toBe(false);
  });

  it('still returns the works it did reach on a truncated dig', async () => {
    stubChannel({ ...videoSnapshot, statedTotal: 29, saturated: true });
    const res = await douyinAdapter.fetchLatest(channel, 50, { isHistory: true });
    expect(res.posts.length).toBe(videoSnapshot.items.length);
    expect(res.error).toBeUndefined();
    expect(res.authorMeta?.name).toBe('示例创作者');
  });

  it('does not claim end-of-history when the stated total is unknown', async () => {
    // The header count could not be read as a plain integer (anonymous page,
    // abbreviated count, or a layout change): a saturated grid then carries NO
    // evidence of completeness. This is the exact shape that parked real user
    // channels at __END__ while older works (e.g. one from last year) remained
    // unsynced — hasMore:false on guesswork permanently blocked the dig.
    //
    // The snapshot is trimmed to recent works only, mirroring the real capture:
    // 18 items stopping ~2 months back, older ones behind the login wall.
    const recentOnly = { ...videoSnapshot, items: videoSnapshot.items.slice(0, 2) };
    stubChannel({ ...recentOnly, statedTotal: 0, saturated: true });
    const res = await douyinAdapter.fetchLatest(channel, 50, { isHistory: true });
    expect(res.hasMore).not.toBe(false);
    // The loaded works are still returned — the dig makes progress.
    expect(res.posts.length).toBe(recentOnly.items.length);
    expect(res.error).toBeUndefined();
  });

  it('explains a saturated dig with no stated total and nothing new', async () => {
    const recentOnly = { ...videoSnapshot, items: videoSnapshot.items.slice(0, 2) };
    stubChannel({ ...recentOnly, statedTotal: 0, saturated: true });
    const newest = Math.max(
      ...recentOnly.items.map((i) => Number(BigInt(i.awemeId) >> 32n) * 1000),
    );
    const res = await douyinAdapter.fetchLatest(channel, 50, {
      isHistory: true,
      sinceTimestamp: newest,
    });
    expect(res.posts).toEqual([]);
    // The honest answer names the missing evidence, never a silent zero.
    expect(res.error?.code).toBe('auth');
    expect(res.error?.message).toContain('无法确认');
  });

  it('may end the dig when the unknown-total grid reaches far into the past', async () => {
    // The oldest fixture work is from 2022 — well past the anonymous
    // ~6-month window. A saturated grid whose loaded history spans years has
    // almost certainly reached the creator's beginning, so the dig may end.
    // (This fixture retains its 2022 work, unlike the trimmed variants above.)
    stubChannel({ ...videoSnapshot, statedTotal: 0, saturated: true });
    const res = await douyinAdapter.fetchLatest(channel, 50, { isHistory: true });
    expect(res.hasMore).toBe(false);
  });
});
