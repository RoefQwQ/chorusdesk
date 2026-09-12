// @vitest-environment jsdom
// The adapter parses the feed with `DOMParser`, which the default node environment
// does not provide — every case failed as a `network` error until this line existed,
// which is a good reminder that a mocked `bgFetch` is not the only environment the
// code needs.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Channel } from '../src/types';

/**
 * YouTube's `@handle → channelId` resolution.
 *
 * `DEVELOPMENT.md` §10 records that the RSS mapping is deliberately untested (a flat
 * `filter().map()` over an official feed has no "half-parsed" state) but that THIS
 * step is the fragile one and was **never measured**: three fallback regexes over page
 * HTML, and if all three miss, the `@handle` is used as a channelId in the RSS request.
 *
 * Measured now (2026-09-12, live):
 *
 *     .../feeds/videos.xml?channel_id=@nonexistent_handle_zzz  -> HTTP 404
 *     .../feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv -> HTTP 404
 *
 * So an unresolved handle does NOT produce a silent empty feed — the RSS fetch fails
 * and the adapter reports a network error. That is the rule 13-compliant behaviour,
 * and these tests pin each branch so a regex drifting cannot change it quietly.
 *
 * The HTML is hand-written because this step parses a *page*, and page HTML has no
 * stable payload to capture — the three shapes come from the patterns the regexes
 * were written against. That is the honest limit of this fixture, stated rather than
 * implied.
 */

const served: Array<{ match: string; ok: boolean; status: number; body: string }> = [];
const requested: string[] = [];

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    requested.push(url);
    for (const e of served) {
      if (url.includes(e.match)) return { ok: e.ok, status: e.status, data: e.body };
    }
    return { ok: false, status: 404, data: '' };
  },
}));

import { youtubeAdapter } from '../src/adapters/youtube';

const channel = (accountId: string): Channel => ({
  id: `youtube:${accountId}`,
  creatorId: 'c1',
  platform: 'youtube',
  accountId,
  displayName: 'YouTube',
  status: 'idle',
  profileUrl: `https://www.youtube.com/${accountId}`,
});

/** A minimal but complete RSS document for a channel id. */
const rssFor = (id: string, title = '示例视频') => `<?xml version="1.0"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
  <author><name>示例频道</name></author>
  <entry>
    <yt:videoId>vid${id.slice(-4)}</yt:videoId>
    <title>${title}</title>
    <published>2026-09-11T00:00:00+00:00</published>
    <media:description>合成简介</media:description>
    <link href="https://www.youtube.com/watch?v=vid${id.slice(-4)}"/>
  </entry>
</feed>`;

const RESOLVED = 'UCabcdefghijklmnopqrstuv'; // 24 chars: UC + 22
const OTHER = 'UCzyxwvutsrqponmlkjihgfe';

beforeEach(() => {
  served.length = 0;
  requested.length = 0;
});

describe('youtube — resolving @handle to a channelId', () => {
  it('resolves from the feed link in the page HTML', async () => {
    served.push({
      match: '/@handle',
      ok: true,
      status: 200,
      body: `<html><head><meta property="og:title" content="示例频道 - YouTube"><meta property="og:image" content="https://yt3.ggpht.com/x.jpg"></head><body><a href="https://www.youtube.com/feeds/videos.xml?channel_id=${RESOLVED}">RSS</a></body></html>`,
    });
    served.push({ match: `channel_id=${RESOLVED}`, ok: true, status: 200, body: rssFor(RESOLVED) });

    const res = await youtubeAdapter.fetchLatest(channel('@handle'));

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(1);
    // The resolved id is what got requested, not the handle.
    expect(requested.some((u) => u.includes(`channel_id=${RESOLVED}`))).toBe(true);
    expect(requested.some((u) => u.includes('channel_id=@handle'))).toBe(false);
    // `og:title` wins over `<title>`, and it is NOT stripped of the " - YouTube"
    // suffix — only the `<title>` branch does that. Recorded as found: a page whose
    // og:title carries the suffix yields a name with it, which is cosmetic but is
    // the actual behaviour.
    expect(res.authorMeta?.name).toBe('示例频道 - YouTube');
  });

  it('falls back to the canonical link when the feed link is absent', async () => {
    served.push({
      match: '/@handle2',
      ok: true,
      status: 200,
      body: `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${OTHER}"><title>别的频道 - YouTube</title></head></html>`,
    });
    served.push({ match: `channel_id=${OTHER}`, ok: true, status: 200, body: rssFor(OTHER) });

    const res = await youtubeAdapter.fetchLatest(channel('@handle2'));

    expect(res.error).toBeUndefined();
    expect(requested.some((u) => u.includes(`channel_id=${OTHER}`))).toBe(true);
    // The <title> branch strips the trailing " - YouTube".
    expect(res.authorMeta?.name).toBe('别的频道');
  });

  it('falls back to the inline channelId when neither link is present', async () => {
    served.push({
      match: '/@handle3',
      ok: true,
      status: 200,
      body: `<html><head><title>第三个频道 - YouTube</title></head><body><script>var ytInitialData={"channelId":"${OTHER}"};</script></body></html>`,
    });
    served.push({ match: `channel_id=${OTHER}`, ok: true, status: 200, body: rssFor(OTHER) });

    const res = await youtubeAdapter.fetchLatest(channel('@handle3'));

    expect(res.error).toBeUndefined();
    expect(requested.some((u) => u.includes(`channel_id=${OTHER}`))).toBe(true);
  });

  it('reports a parse error when all three miss, without firing the doomed RSS request', async () => {
    // MEASURED: an unresolvable id yields HTTP 404 from the feed endpoint, so a
    // silent "0 posts, success" is exactly what rule 13 forbids.
    //
    // Changed 2026-09-13: the page LOADED (`ok: true`) and none of the three
    // regexes matched, which is a parsing outcome, not a network one. The old
    // code carried the `@handle` into the RSS request anyway, got the 404 and
    // reported `network` — a parse problem wearing a network label, which also
    // fed the platform cool-down (rule 19). It now stops before the request.
    served.push({ match: '/@ghost', ok: true, status: 200, body: '<html><body>no ids here</body></html>' });

    const res = await youtubeAdapter.fetchLatest(channel('@ghost'));

    expect(res.posts).toEqual([]);
    expect(res.error).toBeTruthy();
    expect(res.error!.code).toBe('parse');
    // The improvement: the handle never reaches the feed endpoint, because that
    // request cannot succeed (measured: `channel_id=@YouTube` → 404).
    expect(requested.some((u) => u.includes('channel_id=@ghost'))).toBe(false);
    expect(requested.some((u) => u.includes('feeds/videos.xml'))).toBe(false);
  });

  it('reports a network error when the channel page itself cannot be fetched', async () => {
    // The other half of the split above: no page means no basis for calling it a
    // parse failure, and the user's action differs (check the connection).
    served.push({ match: '/@offline', ok: false, status: 503, body: '' });

    const res = await youtubeAdapter.fetchLatest(channel('@offline'));

    expect(res.error?.code).toBe('network');
    expect(requested.some((u) => u.includes('feeds/videos.xml'))).toBe(false);
  });

  it('does not fetch a page at all when the id is already a channel id', async () => {
    served.push({ match: `channel_id=${RESOLVED}`, ok: true, status: 200, body: rssFor(RESOLVED) });

    const res = await youtubeAdapter.fetchLatest(channel(RESOLVED));

    expect(res.error).toBeUndefined();
    expect(res.posts).toHaveLength(1);
    // Only the RSS call, no page fetch: `UC…` short-circuits the resolution step.
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('feeds/videos.xml');
  });
});
