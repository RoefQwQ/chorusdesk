import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import { profileInitialState } from './fixtures/xiaohongshu/profile-state';

/**
 * The image-note enrichment pass, and the invariant that protects the post when it
 * cannot help.
 *
 * Why this file exists: the pass had no coverage at all, and that blind spot is
 * precisely what hid a mistake of mine — when the state extraction moved into
 * `profileState.ts`, I rewired only the `fetchLatest` call and left the enrichment path
 * calling the ORIGINAL local function. Nine green assertions said nothing about it,
 * because every one of them mocks this pass to fail.
 *
 * The invariant under test is stated in the source as: "Only replace when the detail
 * page actually provided more images; otherwise keep the cover (a failed parse must not
 * blank the post)". That is the thing worth protecting — enrichment is best-effort, and
 * the failure mode it must never have is a post that loses its only image.
 *
 * MEASURED (2026-09-12, live, via the user's own session): the detail page's SSR
 * `__INITIAL_STATE__` carries `"noteDetailMap":{}` and `currentNoteId: undefined`, on
 * both `/explore/<id>` and `/discovery/item/<id>` — HTTP 200, 111,638 bytes, identical
 * for either path. So the nested read this pass depends on
 * (`state.note.noteDetailMap[noteId].note.imageList`) finds nothing in the server HTML.
 *
 * That is recorded here, not "fixed": whether the field is populated only for a signed
 * /explore URL, only after client hydration, or never any more is not established, and
 * acting on a guess is how this session's worst mistake happened. What these tests pin
 * is the behaviour that must hold either way.
 */

const served: Array<{ match: string; ok: boolean; status: number; body: string }> = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    for (const e of served) {
      if (url.includes(e.match)) return { ok: e.ok, status: e.status, data: e.body };
    }
    return { ok: false, status: 404, data: '' };
  },
}));

import { xiaohongshuAdapter } from '../src/adapters/xiaohongshu';

const channel: Channel = {
  id: 'xiaohongshu:user',
  creatorId: 'c1',
  platform: 'xiaohongshu',
  accountId: '63799a52000000001f01ca92',
  displayName: '小红书用户_63799a',
  status: 'idle',
  profileUrl: 'https://www.xiaohongshu.com/user/profile/63799a52000000001f01ca92',
};

/** The fixture's newest note — the id the adapter will look up in the detail map. */
const NEWEST_NOTE_ID = '6a0000020000000025037c02';

const profilePage = (state: unknown) =>
  `<!doctype html><script>window.__INITIAL_STATE__=${JSON.stringify(state)}</script>`;

/** The measured detail-page shape: a well-formed state whose map is empty. */
const detailPageEmptyMap = () =>
  `<!doctype html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{},"currentNoteId":undefined},"user":{}}</script>`;

/** A detail page that DOES carry the note, for the success path. */
const detailPageWithImages = (noteId: string, urls: string[]) =>
  `<!doctype html><script>window.__INITIAL_STATE__=${JSON.stringify({
    note: { noteDetailMap: { [noteId]: { note: { imageList: urls.map((u) => ({ urlDefault: u })) } } } },
  })}</script>`;

beforeEach(() => {
  served.length = 0;
});

describe('xiaohongshu — image-note enrichment', () => {
  it('keeps the cover when the detail page carries an empty noteDetailMap', async () => {
    // The measured real shape. The post must come back with its cover intact.
    served.push({ match: '/user/profile/', ok: true, status: 200, body: profilePage(profileInitialState) });
    served.push({ match: '/explore/', ok: true, status: 200, body: detailPageEmptyMap() });

    const res = await xiaohongshuAdapter.fetchLatest(channel, 10);

    expect(res.error).toBeUndefined();
    expect(res.posts.length).toBeGreaterThan(0);
    for (const p of res.posts) {
      expect(p.mediaList).toHaveLength(1);
      expect(p.mediaList[0].previewUrl).toContain('xhscdn.com');
    }
  });

  it('keeps the cover when the detail fetch fails outright', async () => {
    served.push({ match: '/user/profile/', ok: true, status: 200, body: profilePage(profileInitialState) });
    served.push({ match: '/explore/', ok: false, status: 500, body: '' });

    const res = await xiaohongshuAdapter.fetchLatest(channel, 10);

    expect(res.error).toBeUndefined();
    for (const p of res.posts) expect(p.mediaList).toHaveLength(1);
  });

  it('replaces the cover when the detail page provides several images', async () => {
    // The path the pass exists for. Three notes, but the cap is 3 per round and the
    // detail response is shared, so every returned post should be widened.
    const imgs = [
      'https://sns-img-qc.xhscdn.com/synthetic_detail_0.jpg',
      'https://sns-img-qc.xhscdn.com/synthetic_detail_1.jpg',
    ];
    served.push({ match: '/user/profile/', ok: true, status: 200, body: profilePage(profileInitialState) });
    served.push({ match: '/explore/', ok: true, status: 200, body: detailPageWithImages(NEWEST_NOTE_ID, imgs) });

    const res = await xiaohongshuAdapter.fetchLatest(channel, 1);
    const post = res.posts[0];

    expect(post.mediaList.length).toBeGreaterThan(1);
    expect(post.mediaList.map((m) => m.previewUrl)).toEqual(imgs);
    // The id prefix survives enrichment: the pass rewrites mediaList only.
    expect(post.id).toMatch(/^xiaohongshu_[0-9a-f]{24}$/);
  });

  it('does not blank a post whose id is outside the ObjectId shape', async () => {
    // The candidate filter is `/^xiaohongshu_[0-9a-f]{24}$/`, so a non-ObjectId post is
    // skipped entirely — it must still come back with its cover.
    served.push({
      match: '/user/profile/',
      ok: true,
      status: 200,
      body: profilePage({
        user: {
          userPageData: { basicInfo: { nickname: '示例博主' } },
          notes: [[{ id: 'not-an-objectid', noteCard: { noteId: 'not-an-objectid', displayTitle: 'T', type: 'normal', cover: { urlDefault: 'https://sns-img-qc.xhscdn.com/c.jpg' } } }]],
        },
      }),
    });
    served.push({ match: '/explore/', ok: true, status: 200, body: detailPageWithImages('not-an-objectid', ['https://sns-img-qc.xhscdn.com/a.jpg', 'https://sns-img-qc.xhscdn.com/b.jpg']) });

    const res = await xiaohongshuAdapter.fetchLatest(channel, 1);

    expect(res.posts).toHaveLength(1);
    expect(res.posts[0].mediaList).toHaveLength(1);
    expect(res.posts[0].mediaList[0].previewUrl).toContain('c.jpg');
  });
});
