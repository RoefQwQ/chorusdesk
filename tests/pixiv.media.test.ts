import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';
import pixivIllust from './fixtures/pixiv/illust-147520202.json';

/**
 * The pixiv adapter's two user-visible defects, both measured against the real
 * endpoint rather than reasoned about.
 *
 * `/ajax/user/{uid}/profile/all` returns **ids only**. The adapter therefore
 * invented a publication time from the work's id and showed an
 * `embed.pixiv.net/decorate.php` badge as the preview. Measured on work
 * 147520202 (really published 2026-07-22):
 *
 *   - the id formula put it at 2026-09-13, which is in the future, so
 *     `Math.min(Date.now(), …)` clamped it to *now* — every card read 「刚刚」;
 *   - `decorate.php` is an HTML embed page, so `<img src>` could never load it.
 *
 * `createDate`/`uploadDate` and `urls.regular` were in the response the whole
 * time. The fixture is that response, captured verbatim.
 *
 * These are the first tests this adapter has ever had, which is why both bugs
 * shipped: every field it read was a guess, and nothing checked the guess.
 */

const channel: Channel = {
  id: 'pixiv:kyoura',
  creatorId: 'c1',
  platform: 'pixiv',
  accountId: '12345678',
  displayName: 'きょーら',
  status: 'idle',
  profileUrl: 'https://www.pixiv.net/users/12345678',
};

/** Every URL the adapter requests, in order. */
let requested: string[] = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    // `/profile/all` lists ids only — exactly what the real endpoint does.
    if (url.includes('/profile/all')) {
      return {
        ok: true,
        status: 200,
        truncated: false,
        data: JSON.stringify({ error: false, body: { illusts: { '147520202': null }, manga: {} } }),
      };
    }
    // `/ajax/illust/{id}` carries the real time and URLs.
    if (/\/ajax\/illust\/\d+$/.test(url)) {
      return { ok: true, status: 200, truncated: false, data: JSON.stringify(pixivIllust) };
    }
    if (url.includes('/ajax/user/')) {
      return { ok: true, status: 200, truncated: false, data: JSON.stringify({ body: { name: 'きょーら' } }) };
    }
    return { ok: false, status: 404, truncated: false, data: '' };
  },
  MAX_RESPONSE_CHARS: 1_000_000,
}));

import { pixivAdapter } from '../src/adapters/pixiv';

beforeEach(() => {
  requested = [];
  vi.useRealTimers();
});

describe('pixiv — the real publication time replaces the id estimate', () => {
  it('uses createDate from the work payload, not a formula', async () => {
    const res = await pixivAdapter.fetchLatest(channel, 10);

    expect(res.posts).toHaveLength(1);
    // The measured fact: this work was published 2026-07-22T16:14:00Z.
    const expected = new Date('2026-07-22T16:14:00+00:00').getTime();
    expect(res.posts[0].publishedAt).toBe(expected);

    // The specific failure, asserted as a negative: the old code clamped to
    // `Date.now()`, so every card claimed to have been posted just now.
    expect(res.posts[0].publishedAt).not.toBeCloseTo(Date.now(), -5);
    expect(new Date(res.posts[0].publishedAt).getUTCFullYear()).toBe(2026);
    expect(new Date(res.posts[0].publishedAt).getUTCMonth()).toBe(6); // July
  });

  it('falls back to uploadDate when createDate is absent', async () => {
    const { createDate, ...rest } = pixivIllust.body as Record<string, unknown>;
    expect(createDate).toBeDefined();
    const spy = vi.spyOn(await import('../src/infrastructure/chrome/http'), 'bgFetch');
    spy.mockImplementation(async (url: string) => {
      if (url.includes('/profile/all')) {
        return { ok: true, status: 200, truncated: false, data: JSON.stringify({ error: false, body: { illusts: { '147520202': null }, manga: {} } }) };
      }
      if (/\/ajax\/illust\/\d+$/.test(url)) {
        return { ok: true, status: 200, truncated: false, data: JSON.stringify({ error: false, body: rest }) };
      }
      return { ok: true, status: 200, truncated: false, data: JSON.stringify({ body: { name: 'n' } }) };
    });

    const res = await pixivAdapter.fetchLatest(channel, 10);
    expect(res.posts[0].publishedAt).toBe(new Date('2026-07-22T16:14:00+00:00').getTime());
    spy.mockRestore();
  });
});

describe('pixiv — media comes from the work payload', () => {
  it('stores the real illustration URL, not the embed page', async () => {
    const res = await pixivAdapter.fetchLatest(channel, 10);
    const media = res.posts[0].mediaList;

    expect(media).toHaveLength(1);
    // i.pximg.net is the image host; `decorate.php` is an HTML embed page and
    // could never render in `<img src>`.
    expect(media[0].previewUrl).toContain('i.pximg.net');
    expect(media[0].previewUrl).not.toContain('decorate.php');
    expect(media[0].previewUrl).toBe(pixivIllust.body.urls.regular);
    expect(media[0].originalUrl).toBe(pixivIllust.body.urls.original);
  });

  it('enriches EVERY work, not just the first three', async () => {
    // The per-round cap of 3 was the wrong scarce resource: it left 7 of 10 cards
    // permanently imageless and misfiled in time. Pacing is per REQUEST now.
    const ids: Record<string, null> = {};
    for (const id of ['147520202', '147520203', '147520204', '147520205', '147520206']) ids[id] = null;
    const spy = vi.spyOn(await import('../src/infrastructure/chrome/http'), 'bgFetch');
    spy.mockImplementation(async (url: string) => {
      if (url.includes('/profile/all')) {
        return { ok: true, status: 200, truncated: false, data: JSON.stringify({ error: false, body: { illusts: ids, manga: {} } }) };
      }
      if (/\/ajax\/illust\/\d+$/.test(url)) {
        return { ok: true, status: 200, truncated: false, data: JSON.stringify(pixivIllust) };
      }
      return { ok: true, status: 200, truncated: false, data: JSON.stringify({ body: { name: 'n' } }) };
    });

    const res = await pixivAdapter.fetchLatest(channel, 10);

    expect(res.posts).toHaveLength(5);
    for (const post of res.posts) {
      expect(post.mediaList[0].previewUrl, post.id).toContain('i.pximg.net');
      expect(post.publishedAt, post.id).toBe(new Date('2026-07-22T16:14:00+00:00').getTime());
    }
    spy.mockRestore();
  });
});
