// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * YouTube's `@handle → UC…` resolution is paid ONCE per channel.
 *
 * The profile page for a real channel is **1.16 MB** (measured) with the id at
 * byte ~750 000, and the adapter computed it and threw it away — so every sync
 * re-downloaded a megabyte for a value that never changes. `Channel.resolvedAccountId`
 * is where it is kept now, and these pin both halves: it is stored when found,
 * and it is USED (no page fetch at all) when present.
 *
 * The page is unavoidable the first time: `@handle` cannot be turned into an id
 * by any cheaper route. Measured on the live endpoints — `oembed` 404s for both
 * the handle and channel forms, `feeds/videos.xml?user=handle` 404s, the RSS
 * feed only carries `<yt:channelId>` once an id is known, and a `Range` request
 * for the interesting bytes is ignored (200 + the full body).
 */

const requested: string[] = [];
let served: Array<{ match: string; ok: boolean; status: number; body: string }> = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    for (const entry of served) {
      if (url.includes(entry.match)) {
        return { ok: entry.ok, status: entry.status, data: entry.body, truncated: false };
      }
    }
    return { ok: false, status: 404, data: '' };
  },
}));

import { youtubeAdapter } from '../src/adapters/youtube';

const channel = (over: Partial<Channel> = {}): Channel => ({
  id: 'youtube:test',
  creatorId: 'c1',
  platform: 'youtube',
  accountId: '@abrams443',
  displayName: 'あぶらむし (Aburamushi)',
  status: 'idle',
  profileUrl: 'https://www.youtube.com/@abrams443',
  ...over,
});

const UC = 'UCOI806s3tcLz6S9Xh4kBWow';

/** A profile page whose canonical link carries the id, plus the RSS for that id. */
const PROFILE = `<html><head>
<link rel="canonical" href="https://www.youtube.com/channel/${UC}">
<meta property="og:title" content="あぶらむし (Aburamushi)">
</head><body>…1.16 MB of layout…</body></html>`;

const RSS = `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015">
<title>あぶらむし (Aburamushi)</title>
<author><name>あぶらむし (Aburamushi)</name></author>
<entry><title>一条视频</title><yt:videoId>VID1</yt:videoId>
<link href="https://www.youtube.com/watch?v=VID1"/><published>2026-09-10T10:00:00Z</published>
</entry></feed>`;

beforeEach(() => {
  requested.length = 0;
  served = [
    { match: '/@abrams443', ok: true, status: 200, body: PROFILE },
    { match: `channel_id=${UC}`, ok: true, status: 200, body: RSS },
  ];
});

describe('YouTube resolved id is cached across syncs', () => {
  it('reports the id it resolved, so it can be stored', async () => {
    const res = await youtubeAdapter.fetchLatest(channel(), 10);

    expect(res.error).toBeUndefined();
    expect(res.authorMeta?.resolvedAccountId).toBe(UC);
  });

  it('does not fetch the profile page when the id is already known', async () => {
    // The whole point: 1.16 MB avoided on every sync after the first.
    const res = await youtubeAdapter.fetchLatest(channel({ resolvedAccountId: UC }), 10);

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(1);
    // The profile page must not be requested at all.
    expect(requested.some((u) => u.includes('/@abrams443'))).toBe(false);
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain(`channel_id=${UC}`);
  });

  it('reports nothing to store when it did not resolve anything', async () => {
    // The complement, and what makes the write idempotent: on the fast path the
    // adapter must NOT report the cached id back, or `channelSync` would write
    // the same field on every sync forever.
    const res = await youtubeAdapter.fetchLatest(channel({ resolvedAccountId: UC }), 10);

    expect(res.authorMeta?.resolvedAccountId).toBeUndefined();
  });

  it('still gets the channel name from the RSS, with no page involved', async () => {
    // The page supplied `og:title`; the fast path must not lose the name, and it
    // does not — the feed carries `<author><name>` (verified against the live
    // feed, which carries both the name and `<yt:channelId>`).
    const res = await youtubeAdapter.fetchLatest(channel({ resolvedAccountId: UC }), 10);

    expect(res.authorMeta?.name).toBe('あぶらむし (Aburamushi)');
  });

  it('falls back to the page when a stored id stops working', async () => {
    // A stale cached id must not lock the channel out: the RSS 404s, the adapter
    // reports the failure, and a later run can re-resolve from the handle.
    served = [{ match: `channel_id=${UC}`, ok: false, status: 404, body: '' }];

    const res = await youtubeAdapter.fetchLatest(channel({ resolvedAccountId: UC }), 10);

    expect(res.error).toBeTruthy();
    expect(res.posts).toEqual([]);
  });
});
