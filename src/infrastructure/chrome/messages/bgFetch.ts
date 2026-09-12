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
 * Hard ceiling on a response body, in characters.
 *
 * Applied HERE rather than in each consumer because this is the only layer that
 * can stop the bytes: the body is read into a string and then crosses the
 * message boundary into an extension page. A `data:` URI in particular can be
 * megabytes with no network involved, and the RSS host is user-supplied by
 * design (AGENTS rule 3), so an unbounded read is not acceptable.
 *
 * **Raised from 250 000 to 1 000 000 on 2026-09-13, on measurement.** The old
 * figure was not just tight, it was internally inconsistent: the RSS adapter is
 * designed to keep `RSS_MAX_HTML_CHARS` (60 000) of markup per article, so a
 * 10-item page is *supposed* to carry up to 600 000 — more than the transport
 * allowed. Measured against the user's real feed:
 *
 *   - total body: 268 021 characters for 10 items (~26 800 each)
 *   - truncated at 250 000, mid-`<img>`: `…m001_45d99f51.png" alt=""&gt;&lt;/p`
 *   - so the closing `</content:encoded></item></channel></rss>` never arrived
 *
 * A truncated XML document is malformed by definition, which is why the adapter
 * reported 「不是有效 XML」 — our own cut being blamed on the source. 1 000 000
 * holds that real feed with 3.7× headroom, and the largest single article ever
 * measured here (31 144 characters) 32 times over.
 *
 * A cap can still be hit — a 100-item force refresh at the measured density
 * would need ~2.7 M — which is why `readCapped` now REPORTS truncation instead of
 * silently returning a prefix. Any remaining cut is a marked, reportable
 * degradation rather than a fake parse error.
 */
export const MAX_RESPONSE_CHARS = 1_000_000;

/**
 * Read at most `MAX_RESPONSE_CHARS`, and say whether the body was cut.
 *
 * The flag is the important half. Before it, a truncated body was
 * indistinguishable from a complete one, so every caller reported the symptom it
 * saw (`parsererror`, a JSON parse failure) and named the wrong cause. Consumers
 * must now be able to say "the response was incomplete" rather than "the source
 * is malformed".
 */
async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    // No stream (older runtime / already-buffered): fall back, then truncate.
    const whole = await res.text();
    return whole.length > MAX_RESPONSE_CHARS
      ? { text: whole.slice(0, MAX_RESPONSE_CHARS), truncated: true }
      : { text: whole, truncated: false };
  }
  const decoder = new TextDecoder();
  let out = '';
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
      if (out.length > MAX_RESPONSE_CHARS) {
        out = out.slice(0, MAX_RESPONSE_CHARS);
        truncated = true;
        // Stop pulling the body; the connection is released on cancel.
        await reader.cancel().catch(() => {});
        break;
      }
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock?.();
  }
  return { text: out, truncated };
}

/**
 * A one-line description of what the response BODY looks like — not its content.
 *
 * Added after three real failures in one session were each undiagnosable from the
 * log even though the answer was in the response the whole time:
 *
 *   - the RSS feed's URL served `text/html` (a Cloudflare-cached copy of the site
 *     root) instead of XML, so the adapter threw `parsererror` and the log said
 *     only `HTTP 200` … `同步失败（network）`;
 *   - a YouTube `@handle` fell through all three resolution regexes, so the RSS
 *     request carried a handle where an id belongs and got 404 — again invisible;
 *   - a Xiaohongshu profile returned 200 with an SSR payload the extractor does
 *     not recognise.
 *
 * In each case `Content-Type` plus the leading bytes would have named the cause
 * immediately. This records **shape only** — media type, length, and a tiny
 * classifier — never the body, which can carry a session token or user content
 * (rule 11: the panel gets screenshotted into bug reports).
 */
function describeBody(contentType: string, text: string): string {
  const mime = (contentType.split(';')[0] || '').trim().toLowerCase() || '未知类型';
  const head = text.slice(0, 400).replace(/\s+/g, ' ').trimStart();
  const kind =
    head.startsWith('<!doctype html') || head.startsWith('<html')
      ? 'HTML 文档'
      : head.startsWith('<?xml')
        ? 'XML 声明开头'
        : head.startsWith('<')
          ? 'XML/标记（无声明）'
          : head.startsWith('{') || head.startsWith('[')
            ? 'JSON'
            : head
              ? '纯文本/其他'
              : '空响应';
  return `${mime}，${kind}，${text.length} 字符`;
}

export interface BgFetchResult {
  ok: boolean;
  status: number;
  statusText?: string;
  data: string;
  error?: string;
  /**
   * The body exceeded `MAX_RESPONSE_CHARS` and was cut.
   *
   * Callers MUST check this before blaming a parse failure on the source: a
   * truncated XML or JSON document is malformed by construction, and reporting
   * that as 「不是有效 XML」 named the wrong cause for a real user twice
   * (the RSS feed and the Xiaohongshu profile, both cut at the old 250 000).
   */
  truncated?: boolean;
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
    const started = Date.now();
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      headers,
      credentials: isPlatformHost(hostname) ? 'include' : 'omit',
      signal,
    });
    const { text: data, truncated } = await readCapped(res);
    // Host + status + body SHAPE. The URL can carry query tokens and the body is
    // never logged; the shape is what turns "HTTP 200" into a diagnosis (see
    // `describeBody`).
    const credentials = isPlatformHost(hostname) ? 'include' : 'omit';
    const detail = `凭据：${credentials}，${describeBody(res.headers.get('content-type') || '', data)}${truncated ? '（已截断，内容不完整）' : ''}，${Date.now() - started}ms`;
    const outcome = `${hostname} → HTTP ${res.status}`;
    // A truncated body is a WARNING even on HTTP 200: it is a real degradation,
    // and the caller is about to see a parse failure it must not misattribute.
    if (res.ok && !truncated) devLog.debug('bgFetch', outcome, detail);
    else devLog.warn('bgFetch', outcome, detail);
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data,
      truncated,
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
