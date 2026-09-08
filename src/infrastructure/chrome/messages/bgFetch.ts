import { hostMatches, isPlatformHost, parseFetchableUrl } from './hosts';

// Minimal local types for the BG_FETCH runtime-message contract. They only
// describe what this handler reads / replies with — the protocol shape itself
// is unchanged (see src/utils/http.ts bgFetch() for the caller side).
interface BgFetchMessage {
  type: 'BG_FETCH';
  url?: string;
  options?: {
    headers?: Record<string, string>;
  };
}

type SendResponse = (response?: unknown) => void;

export interface BgFetchResult {
  ok: boolean;
  status: number;
  statusText?: string;
  data: string;
  error?: string;
}

/** Error-message extraction mirroring `err?.message || 'Background fetch error'`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || 'Background fetch error';
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = err.message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Background fetch error';
}

/**
 * Performs the CORS-exempt cross-origin GET. Callable directly — the service
 * worker MUST use this instead of messaging itself, because
 * `chrome.runtime.sendMessage` never reaches listeners in the sending context.
 *
 * Security rules enforced here (see also `hosts.ts`):
 *  - the URL must parse as http(s) with no embedded credentials;
 *  - cookies are attached (`credentials: 'include'`) ONLY for declared platform
 *    hosts. Arbitrary hosts — the RSS adapter accepts any user-entered feed
 *    URL — are fetched with `credentials: 'omit'`, so a hostile or mistyped
 *    feed URL can never carry the user's session;
 *  - the stored Rplay bearer token is injected only when the request host is
 *    actually rplay.live (or a subdomain), matched on the parsed hostname.
 *    A substring test such as `url.includes('rplay.live')` would also match
 *    `https://evil.example/?ref=rplay.live` and leak the token.
 *
 * Only GET is issued: every adapter call site is a read.
 */
export async function performBgFetch(
  rawUrl: unknown,
  headerOverrides?: Record<string, string>,
): Promise<BgFetchResult> {
  const parsed = parseFetchableUrl(rawUrl);
  if (!parsed) {
    return { ok: false, status: 0, data: '', error: '请求地址无效（仅支持 http/https）' };
  }

  const headers: Record<string, string> = { ...(headerOverrides || {}) };
  const { hostname } = parsed;

  if (hostMatches(hostname, 'bilibili.com') || hostMatches(hostname, 'hdslb.com')) {
    // Bilibili cookies (incl. HttpOnly SESSDATA / bili_jct) cannot be set via the
    // fetch "Cookie" header: browsers forbid and silently strip it, which caused
    // unauthenticated "访问权限不足" responses. They are attached automatically by
    // fetch's credentials: 'include' (host permissions already declared in the manifest).
    // Note: User-Agent / Referer / Origin are also browser-forbidden headers and are
    // ignored even if set here; the browser sends its own real UA automatically. The
    // adapter relies on medialist (which needs no special headers) as the authoritative
    // source, so the risk-controlled dynamic feed is only a best-effort supplement.
    try {
      const cookies = await Promise.all([
        chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'SESSDATA' }),
        chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'DedeUserID' }),
        chrome.cookies.get({ url: 'https://www.bilibili.com', name: 'buvid3' }),
      ]);
      if (!cookies.some((cookie) => Boolean(cookie?.value))) {
        console.warn(
          '[Background] Bilibili: no login/device cookies found; the dynamic feed may be risk-controlled (video list will still work)'
        );
      }
    } catch (error) {
      console.warn('[Background] Bilibili cookie read failed:', error);
    }
  }

  if (hostMatches(hostname, 'rplay.live')) {
    if (!headers['Referer']) headers['Referer'] = 'https://rplay.live/';
    if (!headers['Origin']) headers['Origin'] = 'https://rplay.live';
    if (!headers['platform-type']) headers['platform-type'] = 'web';
    if (chrome.storage?.local && !headers['Authorization'] && !headers['authorization']) {
      try {
        const stored = await chrome.storage.local.get('rplay_auth_token');
        if (typeof stored?.rplay_auth_token === 'string' && stored.rplay_auth_token) {
          headers['Authorization'] = stored.rplay_auth_token;
        }
      } catch (e) {
        console.warn('[Background] Rplay token inject error:', e);
      }
    }
  }

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      credentials: isPlatformHost(hostname) ? 'include' : 'omit',
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data: await res.text(),
    };
  } catch (err) {
    console.error('[Background] Fetch error:', err);
    return { ok: false, status: 0, data: '', error: errorMessage(err) };
  }
}

/**
 * Handles BG_FETCH messages. Sender trust is enforced by the router in
 * `entrypoints/background.ts` before dispatch — this channel performs
 * authenticated reads and returns the body, so an unvalidated caller would
 * turn it into an open proxy over every host permission we hold.
 *
 * Responses:
 *  - `{ ok, status, statusText, data }` mirroring the fetch result
 *  - `{ ok: false, status: 0, data: '', error }` for invalid URLs / failures
 *
 * Returns `true` so the runtime message channel stays open until the async
 * sendResponse fires — callers MUST return this value from the listener.
 */
export function handleBgFetch(message: BgFetchMessage, sendResponse: SendResponse): boolean {
  void performBgFetch(message.url, message.options?.headers).then(sendResponse);
  return true; // Keep message channel open for async response
}
