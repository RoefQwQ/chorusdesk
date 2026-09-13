import { describe, expect, it, vi } from 'vitest';
import {
  archivesMedia,
  canRunInServiceWorker,
  hasPlatformStatedEnd,
  type PlatformAdapter,
} from '../src/adapters/types';
import { getAdapter } from '../src/platform/registry';
import { terminalCursorIsStated } from '../src/sync/cursorState';
import type { Channel, KnownPlatform } from '../src/types';

/**
 * The platform capability model (queue #6).
 *
 * Capabilities are DECLARED BY THE ADAPTER and only queried centrally, so the
 * failure to guard against is a declaration drifting from what the adapter
 * actually does. A declaration nothing checks is a comment.
 *
 * Two of these were real defects, not hypotheticals:
 *
 *  - `backgroundSync`: `douyin` and `twitter` refuse inside `fetchLatest` when
 *    they detect the service worker, which is correct — but the popup's
 *    `SYNC_CHANNEL` runs in the worker *deliberately*, so following such a
 *    creator from the popup could only ever fail. Declaring it lets the caller
 *    refuse before dispatching.
 *  - `paginates`: this fact lived in TWO places (an array in `cursorState.ts` and
 *    the adapters) and had already diverged — `youtube` and `rss` return neither
 *    `nextCursor` nor `hasMore`, so their recorded `__END__` was trusted as a
 *    platform statement when it was an inference.
 */

/** Adapters whose `fetchLatest` can complete inside the service worker. */
const BACKGROUND_CAPABLE: KnownPlatform[] = [
  'bilibili',
  'youtube',
  'pixiv',
  'fantia',
  'xiaohongshu',
  'weibo',
  'rss',
];

describe('capability declarations', () => {
  it('absent means yes, for every capability', () => {
    const bare: PlatformAdapter = {
      platform: 'x',
      fetchLatest: async () => ({ posts: [] }),
    };
    expect(canRunInServiceWorker(bare)).toBe(true);
    expect(hasPlatformStatedEnd(bare)).toBe(true);
    expect(archivesMedia(bare)).toBe(true);
  });

  it('a platform with no adapter keeps the permissive answer', () => {
    // A platform removed from the registry (or a stored legacy key) must not have
    // its behaviour silently changed: `false` here would make every one of its
    // channels clear its end marker and re-dig.
    expect(canRunInServiceWorker(getAdapter('not-a-platform'))).toBe(true);
    expect(hasPlatformStatedEnd(getAdapter('not-a-platform'))).toBe(true);
  });

  it('declares backgroundSync for exactly the page-driven platforms', () => {
    const declared = (Object.keys(ADAPTERS) as KnownPlatform[]).filter(
      (p) => !canRunInServiceWorker(getAdapter(p)),
    );
    expect(new Set(declared)).toEqual(new Set(['douyin', 'twitter']));
  });

  it('every background-capable platform is in the measured allowlist', () => {
    // Both directions: a new adapter that forgets to declare `backgroundSync`
    // defaults to yes, so this catches "declared capable but is not".
    const capable = (Object.keys(ADAPTERS) as KnownPlatform[]).filter((p) =>
      canRunInServiceWorker(getAdapter(p)),
    );
    expect(new Set(capable)).toEqual(new Set(BACKGROUND_CAPABLE));
  });

  it('the declaration matches what the adapter actually does', async () => {
    // The guard that makes the declaration more than a comment. It is asserted on
    // BEHAVIOUR, not on source text: the first version regex-matched
    // `/IS_SERVICE_WORKER/` against each adapter, which its own sibling test
    // criticises ("matching the source would also match a comment that merely
    // mentions the field") — and it became a false positive the moment
    // `xiaohongshu` needed the check for its page-driven DIG while its ordinary
    // SSR sync stays background-capable (`backgroundSync` gates the whole
    // channel, so declaring it false would drop a working platform from
    // auto-sync — see `PlatformAdapter.backgroundSync`).
    //
    // The measurable contract is where the request actually goes. A platform that
    // can complete in the worker reaches the network through `bgFetch`; the two
    // page-driven ones cannot and refuse (or open a message round-trip) before
    // any request is made.
    const probed: string[] = [];
    vi.resetModules();
    vi.doMock('../src/utils/runtime', () => ({ IS_SERVICE_WORKER: true }));
    vi.doMock('../src/infrastructure/chrome/http', () => ({
      bgFetch: async () => {
        // Counted, never resolved usefully: the refusal we are testing happens
        // before the network, so an adapter that gets here has already proven it
        // is background-capable.
        throw new Error('bgFetch probe');
      },
      MAX_RESPONSE_CHARS: 1_000_000,
    }));

    const { getAdapter: freshGetAdapter } = await import('../src/platform/registry');
    const probeChannel = (platform: KnownPlatform): Channel => ({
      id: `${platform}:probe`,
      creatorId: 'creator_probe',
      platform,
      accountId:
        platform === 'rss'
          ? 'https://example.com/feed.xml'
          : platform === 'douyin'
            ? 'MS4wLjABAAAAsyntheticSecUidForTests000000000000'
            : platform === 'xiaohongshu'
              ? '63799a52000000001f01ca92'
              : '12345',
      displayName: '探针',
      status: 'idle',
      profileUrl: 'https://example.com/',
    });

    for (const platform of Object.keys(ADAPTERS) as KnownPlatform[]) {
      const adapter = freshGetAdapter(platform);
      if (!adapter) continue;
      let reachedNetwork = false;
      try {
        const res = await adapter.fetchLatest(probeChannel(platform), 10);
        // A refusal that names the background is the adapter's own statement that
        // it cannot run here — the observable form of `backgroundSync: false`.
        reachedNetwork = !/后台|扩展页面|页面中采集/.test(res.error?.message ?? '');
      } catch (err: unknown) {
        reachedNetwork = /bgFetch probe/.test(String(err));
      }
      probed.push(`${platform}=${reachedNetwork ? 'network' : 'refused'}`);
      expect(
        canRunInServiceWorker(adapter),
        `${platform}: declared backgroundSync=${adapter.backgroundSync ?? 'yes'} but the adapter ${
          reachedNetwork ? 'reaches the network' : 'refuses'
        } in the worker`,
      ).toBe(reachedNetwork);
    }

    // The probe must actually have distinguished the two groups, or the loop above
    // would pass vacuously.
    expect(probed.filter((p) => p.endsWith('refused')).sort()).toEqual([
      'douyin=refused',
      'twitter=refused',
    ]);
  });

  it('terminalCursorIsStated answers from the adapter, not a private list', () => {
    // The fact this replaced was duplicated in `cursorState.ts`, and the copy had
    // already drifted: youtube and rss cannot state an end either, yet they were
    // absent from that list and their `__END__` was trusted.
    //
    // `xiaohongshu` was on the WRONG side of this line for the same reason, and it
    // is the more expensive case: its profile page carries one screen of notes and
    // it declares `hasMore:false` when that screen runs out, which wrote `__END__`
    // and permanently blocked the channel — while the page's own SSR state said
    // `noteQueries[0].hasMore === true` on the very same response (measured
    // 2026-09-13). Moved here once that was measured, together with the adapter
    // fix that stops claiming an end it cannot know.
    for (const platform of ['douyin', 'youtube', 'rss', 'fantia', 'xiaohongshu'] as KnownPlatform[]) {
      expect(terminalCursorIsStated(platform), platform).toBe(false);
    }
    for (const platform of ['bilibili', 'twitter', 'weibo', 'pixiv'] as KnownPlatform[]) {
      expect(terminalCursorIsStated(platform), platform).toBe(true);
    }
  });

  it('a platform declared non-paginating really returns no cursor', async () => {
    // The measurement behind `paginates: false` for youtube/rss, asserted on the
    // RESULT rather than on the source text: they never hand back a cursor, so
    // nothing they produce can be a platform-stated end. Matching the source
    // would also match a comment that merely mentions the field — which is
    // exactly what the first version of this test did.
    const emptyFetch = async () => ({ ok: true, status: 200, data: '', truncated: false });

    for (const platform of ['youtube', 'rss'] as KnownPlatform[]) {
      expect(hasPlatformStatedEnd(getAdapter(platform)), platform).toBe(false);
    }

    vi.resetModules();
    vi.doMock('../src/infrastructure/chrome/http', () => ({ bgFetch: emptyFetch, MAX_RESPONSE_CHARS: 1_000_000 }));
    const { youtubeAdapter } = await import('../src/adapters/youtube');
    const { rssAdapter } = await import('../src/adapters/rss');

    const channel = {
      id: 'x:1',
      creatorId: 'c1',
      platform: 'youtube' as const,
      accountId: 'UCabc',
      displayName: 'T',
      status: 'idle' as const,
      profileUrl: 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc',
    };

    for (const [name, adapter] of [
      ['youtube', youtubeAdapter],
      ['rss', rssAdapter],
    ] as const) {
      const res = await adapter.fetchLatest(channel as never, 10);
      expect(res.nextCursor, `${name} returned a cursor`).toBeUndefined();
      expect(res.hasMore, `${name} claimed hasMore`).toBeUndefined();
    }
  });

  it('rss is the only platform that opts out of media archiving', () => {
    const optingOut = (Object.keys(ADAPTERS) as KnownPlatform[]).filter(
      (p) => !archivesMedia(getAdapter(p)),
    );
    expect(optingOut).toEqual(['rss']);
  });
});

/** The registry's key set, read from the module to avoid restating it. */
const ADAPTERS: Record<string, PlatformAdapter | undefined> = Object.fromEntries(
  (
    [
      'bilibili',
      'youtube',
      'twitter',
      'pixiv',
      'fantia',
      'xiaohongshu',
      'weibo',
      'douyin',
      'rss',
    ] as KnownPlatform[]
  ).map((p) => [p, getAdapter(p)]),
);
