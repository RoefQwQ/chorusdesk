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

/** Each entry is either a body string (HTTP 200) or a full response shape. */
const served: Record<string, string | { body: string; ok: boolean; status: number }> = {};
const requested: string[] = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    for (const [needle, entry] of Object.entries(served)) {
      if (!url.includes(needle)) continue;
      return typeof entry === 'string'
        ? { ok: true, status: 200, data: entry }
        : { ok: entry.ok, status: entry.status, data: entry.body };
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

  it('reports a refusal as a refusal, not as an absent account', async () => {
    // THE REAL SHAPE, measured 2026-09-12 against the live endpoint: a rejected request
    // is an HTTP failure whose BODY carries the business code —
    //   HTTP 412, body {"code":-412,"message":"request was banned"}
    // (a bare request with no Referer answers 412 with HTML instead, so the code has to
    // be optional). This case previously used `{ ok: true, code: -412 }`, which cannot
    // happen, and so asserted against an input reality does not produce.
    served['feed/space'] = { body: JSON.stringify({ code: -412, message: 'request was banned' }), ok: false, status: 412 };
    served['medialist'] = { body: JSON.stringify({ code: -412, message: 'request was banned' }), ok: false, status: 412 };

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.posts).toEqual([]);
    expect(res.error).toBeTruthy();
    // The whole point: it must NOT say the account has nothing. It was refused.
    expect(res.error!.code).not.toBe('not_found');
    // `auth`, not `rate_limit`: the measured cause is a missing session, and the class
    // decides BOTH the wording the user sees (rate_limit's message is replaced by a
    // hardcoded 「请等待 2~3 分钟」) and whether a platform cool-down is persisted.
    expect(res.error!.code).toBe('auth');
    expect(res.error!.message).toContain('登录');
  });

  it('still reports a refusal without a JSON body (HTML 412)', async () => {
    // Measured: a request with no Referer gets 412 with an HTML body, so there is no
    // business code to read. The status alone must still be classified as a refusal.
    served['feed/space'] = { body: '<!DOCTYPE html><html><body>blocked</body></html>', ok: false, status: 412 };
    served['medialist'] = { body: '<!DOCTYPE html><html><body>blocked</body></html>', ok: false, status: 412 };

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.error?.code).toBe('auth');
  });

  it('a refused dynamic feed is NOT a successful empty, even when medialist says code 0', async () => {
    // THE B33 GAP, closed. Medialist covers VIDEO UPLOADS ONLY — it cannot see
    // image/text dynamics. So `medialist code 0 + empty list` while the dynamic
    // feed is risk-controlled (-412) means "the source that would have held the
    // content was refused", not "this account has no content". An account that
    // posts only image/text dynamics is exactly the case that was reported as
    // 「账号可能无投稿或已注销」 (AGENTS rule 13: an empty platform result must
    // name why it is empty, and a fake empty success can park a cursor at
    // __END__ unrecoverably).
    served['feed/space'] = { body: JSON.stringify({ code: -412, message: 'request was banned' }), ok: false, status: 412 };
    served['medialist'] = { body: JSON.stringify({ code: 0, data: { media_list: [] } }), ok: true, status: 200 };

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.posts).toEqual([]);
    // It must surface the dynamic feed's refusal — and specifically must not
    // claim the account is absent.
    expect(res.error).toBeTruthy();
    expect(res.error!.code).not.toBe('not_found');
  });

  it('still treats a genuine empty as empty when BOTH sources answered', async () => {
    // The credible case: the dynamic feed answered successfully with no items,
    // and medialist agrees. That is a real "this account has no content".
    served['feed/space'] = JSON.stringify({ code: 0, data: { items: [], has_more: false } });
    served['medialist'] = { body: JSON.stringify({ code: 0, data: { media_list: [] } }), ok: true, status: 200 };

    const res = await bilibiliAdapter.fetchLatest(channel, 10);

    expect(res.posts).toEqual([]);
    expect(res.error).toBeUndefined();
  });
});
