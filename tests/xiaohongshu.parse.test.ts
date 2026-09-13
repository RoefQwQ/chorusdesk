import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import { profileInitialState } from './fixtures/xiaohongshu/profile-state';

/**
 * What `xiaohongshu.ts` currently produces from a real profile page.
 *
 * Same purpose and same order as the bilibili pin: that adapter is ~390 lines of
 * nested-record reading with no coverage, and the extraction (if it happens) must
 * be provably behaviour-preserving. Every assertion below was written by running
 * the current code against a captured payload and recording the result — none of it
 * was designed, so any change is a signal rather than an expectation of mine.
 *
 * Only `bgFetch` is mocked, so the SSR envelope parsing, the nested-notes
 * flattening, the `undefined` cleaning, the id scheme, the ObjectId-derived
 * timestamp, sorting and `buildPost` all run for real.
 */

const served: Array<{ match: string; body: string; ok?: boolean; truncated?: boolean }> = [];
const requested: string[] = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    for (const entry of served) {
      if (url.includes(entry.match)) {
        return entry.ok === false
          ? { ok: false, status: 500, data: '' }
          : { ok: true, status: 200, data: entry.body, truncated: entry.truncated ?? false };
      }
    }
    // The detail-enrichment pass asks for /explore/<noteId>. Serving a failure is
    // what a risk-controlled detail page looks like, and the adapter treats it as
    // silent (the profile cover stays) — so this keeps the test off that path
    // without pretending enrichment succeeded.
    return { ok: false, status: 500, data: '' };
  },
}));

import { xiaohongshuAdapter } from '../src/adapters/xiaohongshu';

/**
 * `fetchLatest(channel, limit)`.
 *
 * The limit matters for the TEST's runtime, not for coverage: the detail-enrichment
 * pass paces itself 1200 ms per candidate and runs over the posts the call returns,
 * so asking for one post exercises the same code without paying ~2.4 s per case.
 * The count-sensitive assertions use the full limit and pay it once.
 */
const fetchLatest = (limit = 1) => xiaohongshuAdapter.fetchLatest(channel, limit);

const channel: Channel = {
  id: 'xiaohongshu:user',
  creatorId: 'c1',
  platform: 'xiaohongshu',
  accountId: '63799a52000000001f01ca92',
  displayName: '小红书用户_63799a',
  status: 'idle',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/63799a52000000001f01ca92',
};

/** Wrap the state the way the real SSR page does. */
function pageWith(state: unknown, { useUndefined = false } = {}): string {
  const json = JSON.stringify(state);
  const body = useUndefined ? json.replace('"示例简介"', 'undefined') : json;
  return `<!doctype html><html><body><script>window.__INITIAL_STATE__=${body}</script></body></html>`;
}

beforeEach(() => {
  served.length = 0;
  requested.length = 0;
});

describe('xiaohongshu — parsing a captured profile page', () => {
  it('reads the author from userPageData.basicInfo', async () => {
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });

    const res = await fetchLatest();

    expect(res.error).toBeUndefined();
    expect(res.authorMeta?.name).toBe('示例博主');
    expect(res.authorMeta?.avatar).toContain('xhscdn.com');
    // The raw count is what lets the sync log distinguish "the page carried
    // content and we sliced it" from "the page carried nothing".
    expect(res.totalFetched).toBe(3);
  });

  it('flattens the nested notes array and builds one post per note', async () => {
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });

    const res = await fetchLatest(10); // pays the enrichment pacing to see all three

    // Real pages nest notes one level (`notes: [[...]]`); the adapter flattens
    // before reading cards, and a regression there yields zero posts.
    expect(res.posts).toHaveLength(3);
    // Descending by publishedAt, which the adapter sorts explicitly (the waterfall
    // depends on it). The fixture's note order is the real payload's: newest first.
    expect(res.posts.map((p) => p.id)).toEqual([
      'xiaohongshu_6a0000020000000025037c02',
      'xiaohongshu_6a0000010000000025037c01',
      'xiaohongshu_6a0000000000000025037c00',
    ]);
  });

  it('takes the title from the card and folds the like count into the body', async () => {
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });

    const res = await fetchLatest(10);
    const first = res.posts[0]; // note0 is the newest, so it sorts first

    expect(first.title).toBe('示例笔记标题0');
    expect(first.content).toContain('示例笔记标题0');
    expect(first.content).toContain('❤️ 100 次赞同');
    expect(first.originalUrl).toBe('https://www.xiaohongshu.com/explore/' + first.id.slice('xiaohongshu_'.length));
  });

  it('takes publishedAt from the card time, which equals the ObjectId prefix', async () => {
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });

    const res = await fetchLatest(10);

    // `card.time` wins here, and that is the real relationship rather than a
    // coincidence: measured on the captured payload, a card's `time` in ms equals
    // `parseInt(id.slice(0,8), 16) * 1000`. The fixture preserves it, so this also
    // documents the invariant the adapter's ObjectId fallback depends on — an id
    // whose prefix is not a plausible epoch second would silently fall through to
    // Date.now(), which is exactly what the first version of this test tripped on.
    for (const p of res.posts) expect(Number.isFinite(p.publishedAt)).toBe(true);
    expect(res.posts.map((p) => p.publishedAt)).toEqual([1778384898000, 1778384897000, 1778384896000]);
    // Newest-first is a stated invariant (the waterfall sorts on this).
    const times = res.posts.map((p) => p.publishedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('falls back to the cover as a single media item', async () => {
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });

    const res = await fetchLatest();

    for (const post of res.posts) {
      expect(post.mediaList).toHaveLength(1);
      expect(post.mediaList[0].type).toBe('image'); // card.type is 'normal', not 'video'
      expect(post.mediaList[0].previewUrl).toContain('xhscdn.com');
    }
  });

  it('cleans the bare `undefined` tokens real SSR HTML contains', async () => {
    // Real pages write `undefined`, which is not JSON. The adapter rewrites it to
    // `null` before parsing; JSON.stringify cannot produce that token, so the
    // envelope is built by hand here.
    served.push({
      match: '/user/profile/',
      body: `<!doctype html><script>window.__INITIAL_STATE__={"user":{"userPageData":{"basicInfo":{"nickname":"示例博主","desc":undefined}},"notes":[[{"id":"6a0000000000000025037c00","noteCard":{"noteId":"6a0000000000000025037c00","displayTitle":"示例笔记标题0","type":"normal"}}]]}}</script>`,
    });

    const res = await fetchLatest();

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(1);
    expect(res.authorMeta?.name).toBe('示例博主');
  });

  it('errors with a login/structure hint when the page carries no notes', async () => {
    // Rule 13: a platform that yielded nothing to parse must name the cause, not
    // report a clean zero. This adapter already does the right thing — pinned so
    // an extraction cannot quietly turn it into a successful empty sync.
    served.push({
      match: '/user/profile/',
      body: pageWith({ user: { userPageData: { basicInfo: { nickname: '示例博主' } }, notes: [] } }),
    });

    const res = await fetchLatest();

    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('parse');
    expect(res.error?.message).toContain('登录');
  });

  it('errors when the state is missing entirely', async () => {
    served.push({ match: '/user/profile/', body: '<html><body>登录后查看</body></html>' });

    const res = await fetchLatest();

    expect(res.error?.code).toBe('parse');
  });

  it('reports an HTTP failure as a network error, not as an empty account', async () => {
    served.push({ match: '/user/profile/', body: '', ok: false });

    const res = await fetchLatest();

    expect(res.error?.code).toBe('network');
    expect(res.posts).toEqual([]);
  });

  it('blames truncation, not the page structure, when the body was cut', async () => {
    // Measured 2026-09-13: this profile returned exactly 250 000 characters — the
    // old transport ceiling — with the SSR marker present and the JSON severed,
    // so the adapter said 「页面结构可能已调整」 and sent the user hunting a
    // change that never happened. The log line said 「响应中出现标记但 JSON 解析
    // 失败」, which was true and still pointed at the wrong party.
    const json = JSON.stringify({ user: { userPageData: { basicInfo: { nickname: 'x' } } } });
    const cut = `<!doctype html><html><body><script>window.__INITIAL_STATE__=${json.slice(0, 60)}`;
    served.push({ match: '/user/profile/', body: cut, truncated: true });

    const res = await fetchLatest();

    expect(res.error?.code).toBe('parse');
    expect(res.error?.message).toContain('截断');
    expect(res.error?.message).not.toContain('页面结构可能已调整');
  });
});

/**
 * The `asRecord(a) || asRecord(b)` idiom, which is dead code.
 *
 * `asRecord()` returns `{}` for a miss and `{}` is truthy, so the right-hand side
 * is never reached: the fallback reads as working and has never once run. Rule 15
 * records this shape appearing three times already; `resolveAuthorMeta` held two
 * more, in the author-name path, where the consequence is a wrong author rather
 * than a crash — and the fixture always supplies `userPageData.basicInfo` and a
 * `noteCard.user`, so nothing exercised either one.
 *
 * The assertions below are on the *author the user sees*, which is what the
 * fallback exists to produce. They fail on the old code and pass on `firstFilled`.
 */
describe('xiaohongshu — author fallbacks that used to be unreachable', () => {
  const note = {
    id: '649c1f2e0000000012034567',
    noteCard: { displayTitle: 'T', type: 'normal', time: 1686900000000 },
  };

  it('falls back to userProfile.basicInfo when userPageData.basicInfo is absent', async () => {
    // The page carried the author under the other key; the fallback to it was dead.
    served.push({
      match: '/user/profile/',
      body: pageWith({
        user: {
          userProfile: { basicInfo: { nickname: '备用昵称', images: 'https://sns-avatar-qc.xhscdn.com/a.jpg' } },
          notes: [[note]],
        },
      }),
    });

    const res = await fetchLatest();

    expect(res.authorMeta?.name).toBe('备用昵称');
  });

  it('falls back to the note\'s own user block when noteCard.user is absent', async () => {
    // `sampleUserRaw` is found via `n.user.nickname`, then read from
    // `noteCard.user` first — which is empty here, so only the second path can
    // name the author.
    served.push({
      match: '/user/profile/',
      body: pageWith({
        user: {
          notes: [[{ ...note, user: { nickname: '笔记作者', avatar: 'https://sns-avatar-qc.xhscdn.com/b.jpg' } }]],
        },
      }),
    });

    const res = await fetchLatest();

    expect(res.authorMeta?.name).toBe('笔记作者');
  });
});
