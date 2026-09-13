import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import club from './fixtures/fantia/club-recent-posts.json';
import clubWithGallery from './fixtures/fantia/club-with-gallery.json';
import postPhoto from './fixtures/fantia/post-photo-gallery.json';
import postVideo from './fixtures/fantia/post-video-null-comment.json';
import detailsBlank from './fixtures/fantia/details-blank-comment.json';

/**
 * Fantia defects, all found by reading the real API responses.
 *
 * The adapter had no tests, which is how the first three shipped — every one is a
 * *name* that does not exist in the payload, and a name that does not exist makes
 * a loop quietly do nothing.
 *
 *   1. `comment` can be a **Quill delta** (`{"ops":[…]}`) instead of prose. It was
 *      written into `Post.content` verbatim, so the feed showed
 *      `{"ops":[{"insert":"本編→"},{"attributes":…`. Post 4228374 below is one such
 *      post, captured verbatim.
 *   2. The detail body key is **`post_contents`** (plural); the code read
 *      `post_content`, absent from every response.
 *   3. A gallery block's category is **`photo_gallery`**, not `photo`, and its
 *      URLs are a flat string array in **`post_content_photos_micro`** — there is
 *      no `photos[].url` at all.
 *   4. The club list's `comment` is **`null` for most posts** (measured
 *      2026-09-14: 4 of the 6 newest), with the real body only in the post-detail
 *      response — which the adapter was already fetching for images and then
 *      discarding the `comment` from. Those rows stored the title as their body,
 *      so the card showed one line and stopped: the user's screenshot, post
 *      4236630.
 *   5. The list's `thumb` is **`null` on those same posts** while its
 *      `thumb_micro` is a real JPEG, so reading only `thumb.main` rendered the
 *      card with no media at all.
 *
 * Fixtures are captured verbatim from the live endpoints (rules 15/21).
 */

const channel: Channel = {
  id: 'fantia:yume',
  creatorId: 'c1',
  platform: 'fantia',
  accountId: '130541',
  displayName: '迷夜ゆめ',
  status: 'idle',
  profileUrl: 'https://fantia.jp/fanclubs/130541',
};

/** Detail payloads the mock serves, keyed by post id — verbatim captures each. */
const DETAIL_BY_ID: Record<string, unknown> = {
  [String(postPhoto.post.id)]: postPhoto,
  [String(postVideo.post.id)]: postVideo,
  ...detailsBlank,
};

/**
 * The club payload the mock returns. The adapter binds `bgFetch` at module load,
 * so `vi.spyOn` on the mocked module cannot retarget it — the factory is the only
 * seam, and a mutable holder is how a test picks a different club.
 */
const clubResponse = { data: club };

/** Status the mock answers for detail requests; a test lowers it to 403. */
let detailStatus = 200;

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    if (url.includes('/fanclubs/')) {
      return { ok: true, status: 200, truncated: false, data: JSON.stringify(clubResponse.data) };
    }
    const detail = /\/api\/v1\/posts\/(\d+)/.exec(url);
    if (detail) {
      const payload = DETAIL_BY_ID[detail[1]];
      if (payload && detailStatus === 200) {
        return { ok: true, status: 200, truncated: false, data: JSON.stringify(payload) };
      }
      return { ok: false, status: detailStatus, truncated: false, data: '' };
    }
    return { ok: false, status: 404, truncated: false, data: '' };
  },
  MAX_RESPONSE_CHARS: 1_000_000,
}));

import { fantiaAdapter, fantiaCommentText } from '../src/adapters/fantia';

beforeEach(() => {
  // The adapter paces its detail fetches with a real `setTimeout` (platform
  // knowledge: 1.2 s). A test must not pay that in wall clock, and stubbing the
  // delay is the honest way to keep it — the pacing constant stays asserted by
  // the live probe, not by making the suite slow.
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  vi.stubGlobal(
    'setTimeout',
    ((handler: () => void) => {
      handler();
      return 0;
    }) as unknown as typeof setTimeout,
  );
  detailStatus = 200;
  clubResponse.data = club;
});

describe('fantia — a post whose body only the detail response has', () => {
  it('adopts the detail comment when the list omitted it', async () => {
    // Post 4236630 is the user's screenshot: the list's `comment` is `null`, the
    // detail's carries the real body. Pre-fix the adapter stored the title.
    const res = await fantiaAdapter.fetchLatest(channel, 10);
    const post = res.posts.find((p) => p.id === `fantia_${postVideo.post.id}`);
    expect(post).toBeDefined();

    expect(post!.content).toBe(postVideo.post.comment.trim());
    expect(post!.content).not.toBe(post!.title);
    // The body is author text, not the placeholder the list offered.
    expect(post!.content).toContain('本編→');
  });

  it('takes the list thumb_micro when the list thumb is null', async () => {
    // A card with no media at all is what reading only `thumb.main` produced.
    const res = await fantiaAdapter.fetchLatest(channel, 10);
    const post = res.posts.find((p) => p.id === `fantia_${postVideo.post.id}`);
    expect(post!.mediaList).toHaveLength(1);
    expect(post!.mediaList[0].previewUrl).toBe(postVideo.post.thumb_micro);
    expect(post!.mediaList[0].previewUrl).toContain('c.fantia.jp');
  });
});

describe('fantia — a Quill-delta comment becomes readable text', () => {
  it('decodes the delta instead of storing raw JSON', async () => {
    const res = await fantiaAdapter.fetchLatest(channel, 10);

    // The fixture's post 4228374 is the real one whose body is a delta.
    const quillPostId = 4228374;
    const post = res.posts.find((p) => p.id === `fantia_${quillPostId}`);
    expect(post).toBeDefined();
    const content = post!.content;

    // The user's screenshot: raw `{"ops":…` in the feed.
    expect(content).not.toContain('ops');
    expect(content).not.toContain('insert');
    expect(content).not.toContain('attributes');
    // The body text survives.
    expect(content).toContain('まよ～');
    expect(content.length).toBeGreaterThan(40);
  });

  it('leaves a plain-text comment untouched', async () => {
    const res = await fantiaAdapter.fetchLatest(channel, 10);

    // Every other fixture post carries a plain body; those must pass through.
    const plain = res.posts.find((p) => p.id === 'fantia_4217545');
    expect(plain).toBeDefined();
    expect(plain!.content).not.toContain('ops');
    expect(plain!.content.length).toBeGreaterThan(0);
  });

  it('keeps a plain body that merely starts with a brace', () => {
    // Not valid JSON: must be returned as-is, not swallowed.
    expect(fantiaCommentText('{この投稿は準備中です}')).toBe('{この投稿は準備中です}');
  });

  it('joins text and ignores embedded objects in the delta', () => {
    const delta = JSON.stringify({
      ops: [
        { insert: 'line one\n' },
        { insert: { image: 'x.png' } },
        { attributes: { link: 'https://e.com' }, insert: 'a link' },
        { insert: '\n' },
      ],
    });
    // Quill concatenates every `insert`; the object contributes nothing.
    expect(fantiaCommentText(delta).trim()).toBe('line one\na link');
  });

  it('falls back to the title when the delta carries no text', () => {
    expect(fantiaCommentText(JSON.stringify({ ops: [{ insert: { image: 'a.png' } }] }), 'T')).toBe('T');
  });

  it('falls back to the title for an empty comment', () => {
    expect(fantiaCommentText(undefined, 'T')).toBe('T');
    expect(fantiaCommentText('', 'T')).toBe('T');
  });
});

describe('fantia — gallery images actually load', () => {
  it('reads post_contents + post_content_photos_micro and fills the media list', async () => {
    // A club whose one post genuinely carries a photo gallery (fixture pair taken
    // from the same real post: 4231000, whose detail the module mock serves).
    clubResponse.data = clubWithGallery;

    const res = await fantiaAdapter.fetchLatest(channel, 10);
    const post = res.posts.find((p) => p.id === `fantia_${postPhoto.post.id}`);

    expect(post).toBeDefined();
    // The list's single `thumb_micro` is replaced by the full gallery, which is
    // strictly larger — that comparison is what let the one-image seed stand until
    // the detail responded.
    expect(post!.mediaList).toHaveLength(10);

    for (const media of post!.mediaList) {
      expect(media.type).toBe('image');
      // `cc.fantia.jp` is the real image host, verified by downloading one (a
      // valid JPEG). `original_`/`main_` answer 403; the micro variant is what the
      // API offers and what renders.
      expect(media.previewUrl).toContain('fantia.jp/uploads/post_content_photo/');
      expect(media.previewUrl).toMatch(/^https?:\/\//);
      expect(media.originalUrl).toBe(media.previewUrl);
    }
  });
});

describe('fantia — one round corrects the whole preview page', () => {
  it('leaves no post showing the title as its body', async () => {
    // The club preview is 6 posts and the list's `comment` is `null` on most of
    // them (measured 2026-09-14: 4 of 6). The per-round cap therefore has to reach
    // the whole page: at the previous value of 3, the 4th–6th posts kept the title
    // as their body for a whole extra round — the same defect, just for fewer rows.
    //
    // The assertion is the *outcome* (no card is left with the placeholder body),
    // not "N requests were made": a cap is only meaningful by what it fails to
    // cover, and pinning the request count would freeze an implementation detail.
    const blank = club.fanclub.recent_posts.filter((p) => !p.comment);
    expect(blank.length).toBeGreaterThan(3);

    const res = await fantiaAdapter.fetchLatest(channel, 10);
    const stillPlaceholder = res.posts.filter((p) => p.content === p.title).map((p) => p.id);
    expect(stillPlaceholder).toEqual([]);
  });
});

describe('fantia — a refused detail request is reported, not swallowed', () => {
  it('marks the result degraded and names the refusal when every detail fetch 403s', async () => {
    // The user's own session (log, 2026-09-14): the club list returned 200 while
    // all three detail requests returned 403. The sync still reported 「新增 0 条」
    // with no error, so a platform refusal was indistinguishable from a quiet
    // account — and the bodies/galleries silently stayed at the list's value.
    detailStatus = 403;
    const res = await fantiaAdapter.fetchLatest(channel, 10);
    detailStatus = 200;

    expect(res.posts.length).toBeGreaterThan(0);
    expect(res.degraded).toBe(true);
    expect(res.warnings?.[0]).toContain('403');
  });

  it('is not degraded when the detail requests succeed', async () => {
    const res = await fantiaAdapter.fetchLatest(channel, 10);
    expect(res.degraded).toBeUndefined();
    expect(res.warnings).toBeUndefined();
  });
});
