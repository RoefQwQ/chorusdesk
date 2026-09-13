// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pixiv / Fantia author-avatar extraction.
 *
 * Both platforms used to fall through the popup's generic in-page script to
 * `meta[property="og:image"]`, and on neither of them is that the avatar:
 *
 *  - **Pixiv**: measured 2026-09-13 against a real account with an avatar set
 *    (id 11), `og:image` is `https://embed.pixiv.net/user_profile.php?id=11&k=…`
 *    — a dynamic embed page, not an image file. It is never the avatar, with or
 *    without one configured, which is why the popup showed the wrong image
 *    rather than merely a placeholder.
 *  - **Fantia**: the OGC cover (`c.fantia.jp/uploads/fanclub/ogp_image/…jpg`) —
 *    the banner behind the avatar, which is exactly what the bug report showed.
 *
 * Fixes, each matching an existing pattern in this file's subject:
 *  - Pixiv gets an authoritative API fallback, the same shape as the Bilibili
 *    User Card call that was already there (the account id is known from the URL,
 *    so querying by it beats guessing at markup).
 *  - Fantia gets a DOM branch keyed on `fanclub/icon_image/<id>/`, because a real
 *    render carries several 86x86 `img-circle` avatars for a "related creators"
 *    strip — matching the class alone picks a stranger.
 *
 * The payloads below are verbatim shapes captured from those two live endpoints
 * on 2026-09-13 (AGENTS rule 15/21: a fixture written to match the parser only
 * proves the parser agrees with itself).
 */

const bgFetchCalls: string[] = [];
let bgFetchResponse: { ok: boolean; data: string } = { ok: true, data: '' };

vi.mock('../src/infrastructure/chrome/http', () => ({
  bgFetch: async (url: string) => {
    bgFetchCalls.push(url);
    return { ok: bgFetchResponse.ok, status: bgFetchResponse.ok ? 200 : 500, data: bgFetchResponse.data };
  },
}));

// The in-page script is CAPTURED and then actually executed, so a broken DOM
// branch fails this test. (Recorded values replace the real browser's return.)
let injectedFuncs: Array<() => { name: string; avatar: string }> = [];
vi.stubGlobal('chrome', {
  scripting: {
    executeScript: async ({ func }: { func: () => { name: string; avatar: string } }) => {
      injectedFuncs.push(func);
      // Run the function for real: a stub result would let a wrong selector pass.
      try {
        return [{ result: func() }];
      } catch {
        return [{ result: { name: '', avatar: '' } }];
      }
    },
  },
  tabs: { query: async () => [] },
  runtime: { id: 'test' },
});

import { usePageDetection } from '../entrypoints/popup/composables/usePageDetection';

beforeEach(() => {
  bgFetchCalls.length = 0;
  injectedFuncs = [];
  bgFetchResponse = { ok: true, data: '' };
});

describe('pixiv — the avatar comes from the profile API, not og:image', () => {
  it('uses `imageBig` from the live profile response', async () => {
    // Verbatim shape from https://www.pixiv.net/ajax/user/11?full=1 (2026-09-13).
    bgFetchResponse = {
      ok: true,
      data: JSON.stringify({
        error: false,
        message: '',
        body: {
          userId: '11',
          name: 'pixiv事務局',
          image: 'https://i.pximg.net/user-profile/img/2025/01/28/14/59/33/26898736_058dfc75acb3b71f4cdce3fdb7a9da87_50.jpg',
          imageBig: 'https://i.pximg.net/user-profile/img/2025/01/28/14/59/33/26898736_058dfc75acb3b71f4cdce3fdb7a9da87_170.jpg',
        },
      }),
    };

    const { parsed, fetchPixivProfile, detectedAuthorMeta } = usePageDetection();
    parsed.value = {
      platform: 'pixiv',
      accountId: '11',
      cleanUrl: 'https://www.pixiv.net/users/11',
      suggestedName: 'Pixiv画师_11',
    };

    await fetchPixivProfile('11');

    expect(bgFetchCalls).toEqual(['https://www.pixiv.net/ajax/user/11?full=1']);
    expect(detectedAuthorMeta.value.name).toBe('pixiv事務局');
    expect(detectedAuthorMeta.value.avatar).toContain('_170.jpg');
    // The whole point: an embed page must never reach <img src>.
    expect(detectedAuthorMeta.value.avatar).not.toContain('embed.pixiv.net');
  });

  it('leaves the avatar unset for an account with no profile image', async () => {
    // user 19660960 answers `no_profile.png` for BOTH fields — that account has
    // none configured. `undefined` lets the UI draw its letter avatar; pointing
    // <img> at a 1x1 placeholder is worse.
    bgFetchResponse = {
      ok: true,
      data: JSON.stringify({
        error: false,
        body: {
          userId: '19660960',
          name: '1599431438',
          image: 'https://s.pximg.net/common/images/no_profile_s.png',
          imageBig: 'https://s.pximg.net/common/images/no_profile.png',
        },
      }),
    };

    const { fetchPixivProfile, detectedAuthorMeta } = usePageDetection();
    await fetchPixivProfile('19660960');

    expect(detectedAuthorMeta.value.avatar).toBeUndefined();
    expect(detectedAuthorMeta.value.name).toBe('1599431438');
  });

  it('does not request anything for a profile-API error', async () => {
    bgFetchResponse = { ok: true, data: JSON.stringify({ error: true, message: 'not found' }) };

    const { fetchPixivProfile, detectedAuthorMeta } = usePageDetection();
    await fetchPixivProfile('0');

    expect(detectedAuthorMeta.value.avatar).toBeUndefined();
    expect(detectedAuthorMeta.value.name).toBeUndefined();
  });
});

describe('fantia — the avatar is the fanclub icon, not the OGC cover', () => {
  it('picks the icon carrying this fanclub id, not a related creator', async () => {
    // Measured 2026-09-13 from a real fan-club page: the owner's icon is
    // `img-circle` with `fanclub/icon_image/<id>/` in the src, and the page also
    // renders SIX unrelated 86x86 `img-circle` avatars (a "related creators"
    // strip) plus `plan/thumb_default.png` placeholders. Matching the class alone
    // picks a stranger — the id in the src is what identifies the owner.
    document.body.innerHTML = `
      <img class="img-fluid img-circle replace-if-no-image lazyloaded"
           alt="まよいのうしろのいりぐち♡Yume Mayoi Fanclub"
           src="https://c.fantia.jp/uploads/fanclub/icon_image/130541/thumb_webp_2961a61a.webp">
      <img class="img-fluid img-circle replace-if-no-image lazyload"
           alt="おずまのFantia (おずま)"
           src="https://fantia.jp/images/fallback/common/loading-md.jpg">
      <img class="img-fluid img-rounded"
           alt="Tier3-ぷらん"
           src="https://c.fantia.jp/uploads/plan/image/174783/thumb_6ee651de.jpg">
    `;
    // The injected script reads `window.location`; jsdom's default is localhost.
    Object.defineProperty(window, 'location', {
      value: { hostname: 'fantia.jp', pathname: '/fanclubs/130541', href: 'https://fantia.jp/fanclubs/130541' },
      writable: true,
    });

    const { parsed, extractActiveTabAuthorMeta, detectedAuthorMeta } = usePageDetection();
    parsed.value = {
      platform: 'fantia',
      accountId: '130541',
      cleanUrl: 'https://fantia.jp/fanclubs/130541',
      suggestedName: 'Fantia俱乐部_130541',
    };
    await extractActiveTabAuthorMeta(1, 'https://fantia.jp/fanclubs/130541');

    // Assert on what the user ends up seeing, not on the script's return value:
    // the composable is what writes the avatar into the follow form.
    expect(detectedAuthorMeta.value.avatar).toContain('fanclub/icon_image/130541/');
    expect(detectedAuthorMeta.value.avatar).not.toContain('plan/image');
    expect(detectedAuthorMeta.value.avatar).not.toContain('loading-md');
  });
});
