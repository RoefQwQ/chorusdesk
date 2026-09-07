export interface PlatformAuthStatus {
  [platform: string]: boolean;
}

/**
 * Session-status check per platform, mirroring the exact rules the dashboard
 * used to run inline (its `checkPlatformLogins`):
 *
 * - `twitter` checks cookies on `x.com` AND `twitter.com`; when neither has
 *   an auth cookie it falls back to an open x/twitter tab counting as a
 *   usable session (anti-rate-limit same-origin fetching).
 * - `rplay` is a localstorage-token platform: its status comes from the
 *   stored `rplay_auth_token`, never from cookies.
 * - `youtube` (public RSS) is reported ready without any lookup; remaining
 *   platforms are checked against the cookie names they actually required,
 *   on their actual domain.
 *
 * No cookie rules are invented beyond what the dashboard queried. A key is
 * left absent (falsy in the UI) for platforms the dashboard never probed.
 */
export async function checkPlatformCookieLogins(): Promise<PlatformAuthStatus> {
  const result: PlatformAuthStatus = {};
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return result;

  // YouTube official RSS is publicly accessible without login.
  result['youtube'] = true;

  // Platform -> auth cookie names as queried by the dashboard login detector.
  const platformsToCheck: Array<{ key: string; domain: string; authCookieNames: string[] }> = [
    { key: 'bilibili', domain: 'bilibili.com', authCookieNames: ['DedeUserID', 'SESSDATA', 'bili_jct'] },
    { key: 'twitter', domain: 'x.com', authCookieNames: ['auth_token', 'ct0'] },
    { key: 'pixiv', domain: 'pixiv.net', authCookieNames: ['PHPSESSID'] },
    { key: 'fantia', domain: 'fantia.jp', authCookieNames: ['_session_id'] },
    { key: 'rplay', domain: 'rplay.live', authCookieNames: ['connect.sid', 'token', 'accessToken', 'refreshToken'] },
    { key: 'withny', domain: 'withny.fun', authCookieNames: ['withny_session', 'token', 'remember_web'] },
    { key: 'xiaohongshu', domain: 'xiaohongshu.com', authCookieNames: ['web_session', 'a1', 'webId'] },
    { key: 'weibo', domain: 'weibo.com', authCookieNames: ['SUB', 'SUBP', '_T_WM'] },
  ];

  await Promise.all(platformsToCheck.map(async ({ key, domain, authCookieNames }) => {
    if (key === 'twitter') {
      try {
        const xCookies = await chrome.cookies.getAll({ domain: 'x.com' });
        const twCookies = await chrome.cookies.getAll({ domain: 'twitter.com' });
        const allCookies = [...xCookies, ...twCookies];
        let hasAuth = allCookies.some(c => authCookieNames.includes(c.name));
        // Fallback: an open logged-in tab also counts as a usable session.
        if (!hasAuth && chrome.tabs) {
          const tabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] });
          if (tabs.length > 0) hasAuth = true;
        }
        result[key] = hasAuth;
      } catch {
        result[key] = false;
      }
      return;
    }

    if (key === 'rplay') {
      try {
        const stored = chrome.storage?.local
          ? await chrome.storage.local.get('rplay_auth_token')
          : undefined;
        result[key] = Boolean(stored && stored.rplay_auth_token);
      } catch {
        result[key] = false;
      }
      return;
    }

    try {
      const cookies = await chrome.cookies.getAll({ domain });
      const hasAuth = cookies.some(c => authCookieNames.includes(c.name));
      result[key] = hasAuth;
    } catch {
      result[key] = false;
    }
  }));

  return result;
}

/**
 * Read the stored Rplay session token from `chrome.storage.local`
 * (`rplay_auth_token`). Empty string when unavailable.
 */
export async function getStoredRplayToken(): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return '';
  const stored = await chrome.storage.local.get('rplay_auth_token');
  return typeof stored?.rplay_auth_token === 'string' ? stored.rplay_auth_token : '';
}

/**
 * Persist (token) or clear (empty) the stored Rplay session token.
 */
export async function setStoredRplayToken(token: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
  if (token) await chrome.storage.local.set({ rplay_auth_token: token });
  else await chrome.storage.local.remove('rplay_auth_token');
}

/**
 * Result of asking the background to extract an Rplay session token from an
 * open rplay.live tab (`SYNC_RPLAY_TOKEN` message contract).
 */
export interface RplaySyncResult {
  success: boolean;
  token?: string;
  error?: string;
}

/**
 * Client-side wrapper for the `SYNC_RPLAY_TOKEN` background message: the
 * background reads the auth token from an open rplay.live tab and stores it
 * as `rplay_auth_token`. Never rejects — failures and the "not an extension
 * context" case come back as `{ success: false, error }` with the same
 * messages the dashboard login surface used inline.
 */
export async function requestSyncRplayToken(): Promise<RplaySyncResult> {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
    return { success: false, error: '当前运行环境不支持与扩展后台通信' };
  }
  try {
    const res = await chrome.runtime.sendMessage({ type: 'SYNC_RPLAY_TOKEN' });
    const reply = (res ?? {}) as { success?: unknown; token?: unknown; error?: unknown };
    if (reply.success && typeof reply.token === 'string') {
      return { success: true, token: reply.token };
    }
    return {
      success: false,
      error: typeof reply.error === 'string'
        ? reply.error
        : '未能提取到 Rplay 登录凭证。请确认浏览器中已打开 rplay.live 并且处于登录状态，或者点击【手动粘贴】进行设置。',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `同步凭证请求异常: ${message}` };
  }
}
