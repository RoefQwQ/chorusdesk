import { hostMatches, isPlatformHost, parseFetchableUrl } from './hosts';
import { devLog } from '../../../utils/devLog';
import { errorMessage } from '../../../utils/errorMessage';

// Minimal local types for the BG_FETCH runtime-message contract. They only
// describe what this handler reads / replies with — the protocol shape itself
// is unchanged (see src/infrastructure/chrome/http.ts bgFetch() for the caller side).
interface BgFetchMessage {
  type: 'BG_FETCH';
  /** Identifies this request so a later BG_FETCH_ABORT can cancel it. */
  requestId?: string;
  url?: string;
  options?: {
    headers?: Record<string, string>;
  };
}

interface BgFetchAbortMessage {
  type: 'BG_FETCH_ABORT';
  requestId?: string;
}

/**
 * In-flight fetches, keyed by the caller's request id.
 *
 * A page-side `AbortSignal` cannot travel through `chrome.runtime.sendMessage`,
 * so the caller sends a second message naming the request. Without this the
 * worker's `fetch` outlived the sync that requested it: a 45-second timeout
 * resolved on the page while the request kept running, and a retry put two live
 * requests on a platform whose protection model is a request ceiling
 * (AUDIT P1-2 / AGENTS rule 19).
 *
 * Module scope is fine here — unlike mutable state that must not outlive the
 * worker, this map is only meaningful while requests are running, and a torn-down
 * worker takes its fetches with it.
 */
const inFlightFetches = new Map<string, AbortController>();

type SendResponse = (response?: unknown) => void;

/**
 * Hard ceiling on a response body, in characters (audit P2-5/P2-18).
 *
 * Applied HERE rather than in each consumer because this is the only layer that
 * can stop the bytes: the body is read into a string and then crosses the
 * message boundary into an extension page. The per-consumer caps exist
 * (20000/60000 chars in the RSS adapter and sanitizer) but they run AFTER the
 * whole body has been read and transported, so a pathological feed — and the RSS
 * host is user-supplied by design (AGENTS rule 3) — already cost the worker and
 * the message channel everything it had, and a `data:` URI in particular can be
 * megabytes with no network involved.
 *
 * Generous relative to the real numbers: the largest article measured on a live
 * feed was 31144 characters of markup, and a 60-chars-cap downstream means
 * anything past ~4× that is not content we would keep anyway.
 */
const MAX_RESPONSE_CHARS = 250_000;

/** Read at most `MAX_RESPONSE_CHARS` — a guard against a hostile/huge body. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (older runtime / already-buffered): fall back, then truncate.
    return (await res.text()).slice(0, MAX_RESPONSE_CHARS);
  }
  const decoder = new TextDecoder();
  let out = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length >= MAX_RESPONSE_CHARS) {
        out = out.slice(0, MAX_RESPONSE_CHARS);
        // Stop pulling the body; the connection is released on cancel.
        await reader.cancel().catch(() => {});
        break;
      }
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  return out;
}

export interface BgFetchResult {
  ok: boolean;
  status: number;
  statusText?: string;
  data: string;
  error?: string;
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
 *    feed URL can never carry the user's session.
 *
 * Only GET is issued: every adapter call site is a read.
 */
export async function performBgFetch(
  rawUrl: unknown,
  headerOverrides?: Record<string, string>,
  signal?: AbortSignal,
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

  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      credentials: isPlatformHost(hostname) ? 'include' : 'omit',
      signal,
    });
    // Host + status only: the URL can carry query tokens and the body is never
    // logged. This is the line that explains "why is this platform empty".
    const credentials = isPlatformHost(hostname) ? 'include' : 'omit';
    const outcome = `${hostname} → HTTP ${res.status}`;
    if (res.ok) devLog.debug('bgFetch', outcome, `凭据：${credentials}`);
    else devLog.warn('bgFetch', outcome, `凭据：${credentials}`);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data: await readCapped(res),
    };
  } catch (err) {
    // A cancelled request is not a failure: ordering it as one would put a red
    // 「请求失败」 on a channel the user themselves cancelled, and would feed the
    // rate-limit/cooldown machinery a signal it did not earn (rule 19).
    if (signal?.aborted) {
      devLog.debug('bgFetch', `${hostname} 请求已取消`, '调用方中止；结果被丢弃');
      return { ok: false, status: 0, data: '', error: '请求已取消' };
    }
    console.error('[Background] Fetch error:', err);
    devLog.error('bgFetch', `${hostname} 请求失败`, errorMessage(err, 'Background fetch error'));
    return { ok: false, status: 0, data: '', error: errorMessage(err, 'Background fetch error') };
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
  const requestId = typeof message.requestId === 'string' ? message.requestId : '';
  // Only named requests can be cancelled; an unnamed one simply cannot be.
  const controller = requestId ? new AbortController() : undefined;
  if (requestId && controller) inFlightFetches.set(requestId, controller);

  void performBgFetch(message.url, message.options?.headers, controller?.signal)
    .then(sendResponse)
    .finally(() => {
      if (requestId) inFlightFetches.delete(requestId);
    });
  return true; // Keep message channel open for async response
}

/**
 * Handles `BG_FETCH_ABORT`: abort the named in-flight request.
 *
 * Answers synchronously (nothing to await): `{ aborted: boolean }` says whether
 * a live request was found, so a caller can tell "it was still running and is
 * now cancelled" from "it had already finished".
 */
export function handleBgFetchAbort(message: BgFetchAbortMessage): { aborted: boolean } {
  const requestId = typeof message.requestId === 'string' ? message.requestId : '';
  if (!requestId) return { aborted: false };
  const controller = inFlightFetches.get(requestId);
  if (!controller) return { aborted: false };
  controller.abort();
  inFlightFetches.delete(requestId);
  return { aborted: true };
}
