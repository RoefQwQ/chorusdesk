import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import { spaceDynamicDraw, spaceDynamicForwardHeavy } from './fixtures/bilibili/space-dynamic';

/**
 * What `bilibili.ts` currently produces from a real space-dynamic payload.
 *
 * This exists because that adapter had ZERO tests — 435 lines of dense branching,
 * including the branch where a forward's media lives on `item.orig` rather than on
 * the wrapper — and the queue item to fix that is: capture a real payload, then
 * extract the parser, then assert the same payload still parses to the same thing.
 * **This is the middle step's safety net**: every assertion below was written by
 * running the CURRENT code and recording what it produced. Nothing here was
 * designed; if a later refactor changes any of it, that is the signal.
 *
 * `bgFetch` is the only thing mocked, so the request URL, the JSON parsing, the
 * watermark, the forward/dedup/identity filters and `buildPost` all run for real.
 * Serving a captured payload through the adapter's own entry point is what makes
 * this a pin rather than a reimplementation (rule 22: a test that re-implements the
 * thing under test tests nothing).
 *
 * Deliberately NOT asserted: `fetchedAt` (a clock read) and anything about the
 * medialist supplement other than the request being made, since the fixtures are
 * dynamic-feed responses.
 */

const served: Record<string, string> = {};
const requested: string[] = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    for (const [needle, body] of Object.entries(served)) {
      if (url.includes(needle)) return { ok: true, status: 200, data: body };
    }
    // The medialist supplement runs whenever the dynamic feed yields fewer than
    // `limit` items. Answer it with an authoritative empty list (code 0) so the
    // adapter's "no content" path is the one under test, not an error path.
    return { ok: true, status: 200, data: JSON.stringify({ code: 0, data: { media_list: [] } }) };
  },
}));

import { bilibiliAdapter } from '../src/adapters/bilibili';

const channel: Channel = {
  id: 'bilibili:2',
  creatorId: 'c1',
  platform: 'bilibili',
  accountId: '2',
  displayName: 'B站用户_2',
  status: 'idle',
  profileUrl: 'https://space.bilibili.com/2',
};

beforeEach(() => {
  for (const k of Object.keys(served)) delete served[k];
  requested.length = 0;
});

describe('bilibili — parsing a captured space-dynamic payload', () => {
  it('reads the author from module_author and reports the raw item count', async () => {
    served['feed/space'] = JSON.stringify(spaceDynamicForwardHeavy);

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    // `totalFetched` is the adapter's own filter accounting and is what lets the
    // sync log tell "the platform had content, we filtered it away" apart from
    // "the platform returned nothing" (AGENTS rule 13).
    expect(res.totalFetched).toBe(3);
    expect(res.authorMeta?.name).toBe('示例UP主');
    expect(res.authorMeta?.avatar).toContain('hdslb.com');
    expect(res.hasMore).toBe(true);
    expect(res.nextCursor).toBe(spaceDynamicForwardHeavy.data.offset);
  });

  it('gives a forward the original item\'s media, and the right id scheme', async () => {
    served['feed/space'] = JSON.stringify(spaceDynamicForwardHeavy);

    const res = await bilibiliAdapter.fetchLatest(channel, 10);
    const forward = res.posts.find((p) => p.isRepost);

    expect(forward, 'the fixture carries a DYNAMIC_TYPE_FORWARD and it must survive').toBeTruthy();
    // The wrapper has no `major`; the media is on `item.orig.modules.module_dynamic`.
    // That is the branch most likely to break silently, because a forward with no
    // media still produces a valid-looking post.
    expect(forward!.mediaList.length).toBeGreaterThan(0);
    expect(forward!.originalUrl).toMatch(/^https:\/\/t\.bilibili\.com\/|^https:\/\/www\.bilibili\.com\/video\//);
    expect(forward!.id).toMatch(/^bilibili_video_BV|^bilibili_\d/);
  });

  it('takes an AV post from major.archive: video media, bvid-based id and url', async () => {
    served['feed/space'] = JSON.stringify(spaceDynamicForwardHeavy);

    const res = await bilibiliAdapter.fetchLatest(channel, 10);
    // `!isRepost` matters: a FORWARD carries a video too (from its `orig`), so a
    // selector on media type alone picks the wrong post — which is exactly the
    // mistake the first version of this test made.
    const video = res.posts.find((p) => !p.isRepost && p.mediaList.some((m) => m.type === 'video'));

    expect(video, 'the fixture carries a DYNAMIC_TYPE_AV with major.archive').toBeTruthy();
    expect(video!.id).toBe('bilibili_video_BV1SYNTH0002');
    expect(video!.originalUrl).toBe('https://www.bilibili.com/video/BV1SYNTH0002');
    expect(video!.title).toBe('【示例】合成标题');
  });

  it('expands a DRAW item into one image entry per draw item', async () => {
    served['feed/space'] = JSON.stringify(spaceDynamicDraw);

    const res = await bilibiliAdapter.fetchLatest(channel, 10);
    const withImages = res.posts.find((p) => p.mediaList.some((m) => m.type === 'image'));

    expect(withImages, 'the fixture carries DYNAMIC_TYPE_DRAW items').toBeTruthy();
    expect(withImages!.mediaList.every((m) => m.type === 'image')).toBe(true);
    expect(withImages!.originalUrl).toMatch(/^https:\/\/t\.bilibili\.com\/\d/);
    // Content falls back to the title when the description is empty, and to a
    // placeholder when both are — the post must never have an empty body.
    expect(withImages!.content.length).toBeGreaterThan(0);
  });

  it('stops at the watermark, and this path returns no hasMore at all', async () => {
    served['feed/space'] = JSON.stringify(spaceDynamicForwardHeavy);
    // Newest-first: a watermark at the newest item's pub_ts stops immediately.
    const newest = Math.max(
      ...spaceDynamicForwardHeavy.data.items.map(
        (i) => Number((i as { modules: { module_author: { pub_ts: number } } }).modules.module_author.pub_ts) * 1000,
      ),
    );

    const res = await bilibiliAdapter.fetchLatest(channel, 10, { sinceTimestamp: newest });

    expect(res.posts).toEqual([]);
    // RECORDED AS FOUND: `hasMore` is `undefined` here, not `false`. The
    // empty-result branch returns `{ posts, authorMeta, totalFetched }` and drops
    // `hasMore` entirely — note the difference from the watermark `break`, which
    // does set `hasMore = false` locally and then never reaches the return that
    // carries it.
    //
    // Benign today: the watermark is only applied when there is no cursor (a
    // history dig passes `cursor` and gets `sinceTs = 0`), and `channelSync` parks
    // `__END__` only for digs. So no dig can be falsely parked by this. It is
    // pinned so that a change here is a decision rather than an accident.
    expect(res.hasMore).toBeUndefined();
    expect(res.nextCursor).toBeUndefined();
  });

  it('swallows a rejected dynamic feed when medialist answers code 0 with an empty list', async () => {
    // RECORDED AS FOUND, and this one is a suspected gap rather than a design note.
    // The dynamic feed is refused by risk control (-412 is the measured code on the
    // wire), but the medialist supplement answers code 0 with `media_list: []`, which
    // the adapter treats as authoritative ("this account has no videos") and returns
    // a successful empty result.
    //
    // The reasoning behind `mediaSucceeded` is sound for what medialist covers — video
    // uploads — but medialist does NOT cover image or text dynamics. So an account
    // with images and no videos, whose dynamic feed is being rate-limited, is reported
    // as having no content, and the -412 (`lastDynamicCode`) is never surfaced. That
    // is the shape AGENTS rule 13 warns about: a platform that yielded nothing to
    // parse must name the cause, not report a clean zero.
    served['feed/space'] = JSON.stringify({ code: -412, message: 'request was banned' });

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.error).toBeUndefined();
    expect(res.posts).toEqual([]);
    expect(res.totalFetched).toBe(0);
  });

  it('does report the cause when medialist fails too', async () => {
    // The contrast that matters: with medialist ALSO refused, the business code does
    // reach the caller as an error. So the gap above is narrower than "errors are
    // swallowed" — it is specifically "a rejected dynamic feed is invisible whenever
    // medialist succeeds with an empty list".
    served['feed/space'] = JSON.stringify({ code: -412, message: 'request was banned' });
    served['medialist'] = JSON.stringify({ code: -412, message: 'request was banned' });

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.error).toBeTruthy();
    expect(res.error!.code).not.toBe('not_found');
    expect(res.posts).toEqual([]);
  });
});
