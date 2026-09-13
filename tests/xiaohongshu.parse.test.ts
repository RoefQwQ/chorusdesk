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
    // The stored link must carry the page's `xsec_token`: a bare `explore/<id>`
    // answers `error_code=300031` 「当前笔记暂时无法浏览」 and lands on `/404`
    // (the reported bug). Measured 2026-09-13: the token is present on every note
    // and is the same value across all of them.
    const noteId = first.id.slice('xiaohongshu_'.length);
    expect(first.originalUrl).toBe(
      `https://www.xiaohongshu.com/explore/${noteId}?xsec_token=ABsyntheticSharedXsecTokenForFixture%3D&xsec_source=pc_user`,
    );
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
 * A history dig runs in a PAGE, and must not claim an end it cannot know.
 *
 * The profile document carries one screen (~30 notes) and the endpoint that pages
 * it (`user_posted`) needs an `X-S` signature only the page's own JS produces, so
 * older notes are reachable only by driving an open profile page —
 * `FETCH_XHS_NOTES`, the Douyin shape (rule 9). What that page reports back is
 * untrusted until `contract.ts` validates it.
 *
 * The property worth pinning here is the asymmetry of rule 10: `hasMore:false` is
 * what `channelSync` writes as `__END__`, permanently blocking the dig, so it may
 * only be claimed on positive evidence — never from "scrolling stopped helping",
 * because the header's stated total counts notes the author has hidden and a
 * shortfall is therefore permanently true for such a profile.
 */
describe('xiaohongshu — a page-driven dig', () => {
  const noteIds = ['6a0000020000000025037c02', '6a0000010000000025037c01'];

  /** One note as the collector's contract expects it. */
  const pageNote = (id: string, time = 1_778_384_898_000) => ({
    id,
    xsecToken: 'tok',
    title: `页面笔记${id.slice(-4)}`,
    type: 'normal',
    time,
    likedCount: '7',
    nickname: '示例博主',
    avatar: 'https://sns-avatar-qc.xhscdn.com/a.jpg',
    coverUrl: 'https://sns-img.xhscdn.com/c.jpg',
    noteUrl: `https://www.xiaohongshu.com/explore/${id}?xsec_token=tok&xsec_source=pc_user`,
  });

  const snapshotOf = (notes: unknown[], extra: Record<string, unknown> = {}) => ({
    userId: channel.accountId,
    authorName: '示例博主',
    authorAvatar: '',
    notes,
    saturated: false,
    statedTotal: null,
    requiresLogin: false,
    ...extra,
  });

  /** Capture the outgoing message and reply with a canned page snapshot. */
  function stubPage(response: unknown) {
    const sent: Record<string, unknown>[] = [];
    (globalThis as Record<string, unknown>).chrome = {
      runtime: {
        lastError: undefined,
        id: 'test-extension',
        sendMessage: (msg: Record<string, unknown>, cb: (r: unknown) => void) => {
          sent.push(msg);
          cb(response);
        },
      },
    };
    return sent;
  }

  it('asks the page to scroll when digging, and not for a plain sync', async () => {
    const sent = stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])]) });
    await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });
    expect(sent[0]).toMatchObject({ type: 'FETCH_XHS_NOTES', deep: true });

    // An ordinary sync stays on the plain SSR fetch: scrolling is what trips the
    // platform's automation heuristics, so it must not happen on the routine path.
    const plain = stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])]) });
    served.push({ match: '/user/profile/', body: pageWith(profileInitialState) });
    const res = await fetchLatest();
    expect(plain).toHaveLength(0);
    expect(res.posts.length).toBeGreaterThan(0);
    // The SSR path carries one screen and cannot state an ending.
    expect(res.hasMore).toBeUndefined();
  });

  it('scrolls for a cursor page and a force refresh too', async () => {
    for (const options of [{ cursor: '0' }, { forceRefresh: true }]) {
      const sent = stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])]) });
      await xiaohongshuAdapter.fetchLatest(channel, 10, options);
      expect(sent[0]).toMatchObject({ deep: true });
    }
  });

  it('does not claim an end when the grid simply stopped growing', async () => {
    // The exact shape that parked real channels: a saturated grid short of the
    // stated total. `hasMore:false` here would write `__END__` and the user could
    // never dig the remainder.
    stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])], { saturated: true, statedTotal: 29 }) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.hasMore).not.toBe(false);
    expect(res.posts).toHaveLength(1);
    expect(res.error).toBeUndefined();
  });

  it('may end the dig when the page reached the total it states', async () => {
    // Positive evidence: the grid holds at least as many as the header claims, so
    // nothing is being withheld.
    stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])], { saturated: true, statedTotal: 1 }) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.hasMore).toBe(false);
    expect(res.error).toBeUndefined();
  });

  it('explains a short dig that found nothing instead of reporting a clean zero', async () => {
    // Rule 13: an empty result has to name why. The watermark is at the newest
    // note, so the page's only note is filtered as already-known.
    stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])], { saturated: true, statedTotal: 29 }) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, {
      isHistory: true,
      sinceTimestamp: 1_778_384_898_000,
    });

    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('unsupported');
    expect(res.error?.message).toContain('29');
    // Must not blame the user for a shortfall hidden notes explain.
    expect(res.error?.message).toContain('隐藏');
    expect(res.hasMore).not.toBe(false);
  });

  it('names the shortfall when the page yielded no notes at all', async () => {
    stubPage({ success: true, snapshot: snapshotOf([], { statedTotal: 30 }) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('parse');
    expect(res.error?.message).toContain('30');
    expect(res.hasMore).not.toBe(false);
  });

  it('reports a login wall as auth, not as an empty account', async () => {
    stubPage({ success: true, snapshot: snapshotOf([], { requiresLogin: true }) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.error?.code).toBe('auth');
    expect(res.error?.message).toContain('登录');
  });

  it('surfaces a refused page collection rather than an empty success', async () => {
    stubPage({ success: false, code: 'rate_limit', error: '小红书页面出现安全验证' });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.posts).toEqual([]);
    expect(res.error?.code).toBe('rate_limit');
  });

  it('treats an unparseable page snapshot as a structure change', async () => {
    // Not an object at all: the contract rejects it, and the honest code is
    // `parse` (a shape change), never a successful empty sync.
    stubPage({ success: true, snapshot: 'not-an-object' });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.error?.code).toBe('parse');
  });

  it('maps a validated page snapshot onto posts with the stored link intact', async () => {
    stubPage({ success: true, snapshot: snapshotOf([pageNote(noteIds[0])]) });
    const res = await xiaohongshuAdapter.fetchLatest(channel, 10, { isHistory: true });

    expect(res.posts).toHaveLength(1);
    const post = res.posts[0];
    expect(post.id).toBe(`xiaohongshu_${noteIds[0]}`);
    expect(post.publishedAt).toBe(1_778_384_898_000);
    // The click target must carry the page's `xsec_token`: a bare `explore/<id>`
    // answers `error_code=300031` and lands on `/404`.
    expect(post.originalUrl).toContain('xsec_token=tok');
    expect(res.authorMeta?.name).toBe('示例博主');
    expect(res.totalFetched).toBe(1);
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
