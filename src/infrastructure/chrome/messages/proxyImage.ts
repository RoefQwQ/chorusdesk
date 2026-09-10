import { toSecureMediaUrl } from '../../../utils/media';
import { hostMatches, isPlatformHost, parseFetchableUrl, resolveMediaReferer } from './hosts';

/**
 * Xiaohongshu media hosts: images from these need the authenticated session and
 * the `sns-img-*` mirror rewrite, unlike every other platform's CDN.
 */
const XHS_MEDIA_HOSTS = ['xhscdn.com', 'xhscdn.net', 'xiaohongshu.com'] as const;

// Minimal local types for the PROXY_IMAGE runtime-message contract. They only
// describe what this handler reads / replies with — the protocol shape itself
// is unchanged (see src/utils/media.ts proxyImage() for the caller side).
interface ProxyImageMessage {
  type: 'PROXY_IMAGE';
  url?: string;
}

type SendResponse = (response?: unknown) => void;

/** Error-message extraction mirroring `err?.message || 'Proxy image error'`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Proxy image error';
}

/**
 * Handles PROXY_IMAGE messages: fetches the requested image through the
 * extension's host permissions, applying the per-platform Referer header and
 * authenticated cookies (XHS), then converts the body into a base64 data URL.
 *
 * Responses (all `{ ok: ... }`):
 *  - `{ ok: true, dataUrl }` on success
 *  - `{ ok: false, error }` for invalid URLs / unexpected failures
 *  - `{ ok: false, status, error }` when every candidate URL was rejected
 *
 * Returns `true` so the runtime message channel stays open until the async
 * sendResponse fires — callers MUST return this value from the listener.
 */
export function handleProxyImage(message: ProxyImageMessage, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      const url = (message.url as string || '').trim();
      // Host policy comes from `hosts.ts` alone: the proxy previously kept its
      // own regex and had already fallen behind (Douyin covers were documented
      // as proxied while this list rejected them). AGENTS.md rule 2.
      const target = parseFetchableUrl(url);
      if (!target) {
        // Distinguish "not a URL" from "a URL we refuse to fetch", matching the
        // replies callers already handle.
        let parseable = true;
        try {
          new URL(url);
        } catch {
          parseable = false;
        }
        sendResponse({ ok: false, error: parseable ? 'Image host is not allowed' : 'Invalid URL' });
        return;
      }
      // Any http(s) host may be fetched, but only a platform host may carry the
      // user's session. The rule is the one in AGENTS.md rule 3, unchanged by
      // this: membership in the allowlist buys *credentials*, never reachability.
      //
      // This handler used to refuse every non-platform host outright, which made
      // every RSS article image unreadable — a feed may host its images anywhere
      // (measured: `assets.juya.uk`, 23 images in one article), and the proxy is
      // the only path that can load a hotlink-protected or CORS-less CDN. The
      // request is still bounded by `parseFetchableUrl` (http(s) only, no
      // embedded credentials) and by the sender guard on the message itself.
      const onPlatform = isPlatformHost(target.hostname);
      const isXhs =
        onPlatform && XHS_MEDIA_HOSTS.some((domain) => hostMatches(target.hostname, domain));
      // Referer per platform, matched on the parsed hostname — the previous
      // `url.includes('weibo.com')` test would have matched a query parameter.
      // A host we know nothing about gets none: sending another platform's
      // Referer is worse than sending nothing.
      const referer = onPlatform ? resolveMediaReferer(target.hostname) : undefined;

      // Generate candidate URLs to try if first one returns 403/404
      const normalized = toSecureMediaUrl(url);
      const urlsToTry: string[] = [normalized];
      if (normalized !== url) {
        urlsToTry.push(url);
      }
      if (isXhs) {
        try {
          const u = new URL(url);
          const lastSegment = u.pathname.substring(u.pathname.lastIndexOf('/') + 1);
          const fileId = lastSegment.split('!')[0].split('?')[0];
          if (fileId && fileId.length >= 10 && !/^\d{10,14}$/.test(fileId)) {
            const qcUrl = `https://sns-img-qc.xhscdn.com/${fileId}`;
            if (!urlsToTry.includes(qcUrl)) {
              urlsToTry.unshift(qcUrl);
            }
            urlsToTry.push(`https://ci.xiaohongshu.com/${fileId}`);
            urlsToTry.push(`https://sns-img-bd.xhscdn.com/${fileId}`);
            urlsToTry.push(`https://sns-img-hw.xhscdn.com/${fileId}`);
          }
        } catch {
          // Malformed URL: keep the original and normalized candidates.
        }
      }

      let res: Response | null = null;
      let lastStatus = 0;

      for (const targetUrl of urlsToTry) {
        try {
          // CDNs without an expected Referer get none: sending another
          // platform's Referer is worse than sending nothing.
          const headers: Record<string, string> = {
            Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
          };
          if (referer) headers.Referer = referer;

          const fetchOptions: RequestInit = {
            method: 'GET',
            headers,
            // Use 'include' so extension host permissions attach user's authenticated cookies (e.g. web_session, a1)
            credentials: isXhs ? 'include' : 'omit',
          };

          const resp = await fetch(targetUrl, fetchOptions);
          if (resp.ok) {
            res = resp;
            break;
          }
          lastStatus = resp.status;
        } catch {
          // This candidate failed: try the next URL.
        }
      }

      if (!res || !res.ok) {
        sendResponse({ ok: false, status: lastStatus, error: `HTTP ${lastStatus || 403}` });
        return;
      }

      const arrayBuffer = await res.arrayBuffer();
      const mimeType = res.headers.get('content-type') || 'image/jpeg';
      const bytes = new Uint8Array(arrayBuffer);
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
      }
      const base64 = btoa(binary);
      const dataUrl = `data:${mimeType};base64,${base64}`;

      sendResponse({ ok: true, dataUrl });
    } catch (err: unknown) {
      console.error('[Background] PROXY_IMAGE error:', err);
      sendResponse({ ok: false, error: errorMessage(err) });
    }
  })();
  return true;
}
