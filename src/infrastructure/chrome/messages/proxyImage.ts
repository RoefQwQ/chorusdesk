import { toSecureMediaUrl } from '../../../utils/media';
import { devLog } from '../../../utils/devLog';
import { errorMessage } from '../../../utils/errorMessage';
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


/**
 * Ceilings for the image proxy.
 *
 * `PROXY_IMAGE` had none: it read the whole body with `arrayBuffer()`, copied it
 * into a `Uint8Array`, built a JS binary string, base64-encoded that, and sent
 * the result across the runtime message channel — so one response was held in
 * FIVE representations at once, and every one of them is bigger than the last
 * (base64 alone is ~1.37×). A single oversized or hostile response could stall
 * the worker that every platform's sync also runs in.
 *
 * `BG_FETCH` was given a ceiling for exactly this reason; this path was missed.
 * The host is far less trusted here too: the proxy fetches *any* http(s) host by
 * design (AGENTS rule 3 — a feed hosts its images wherever it likes).
 */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The proxy only ever serves images, so anything else is a refusal, not a
 * download. The request already ASKED for images (`Accept: image/…`); this is the
 * server's answer being checked against it — measured motivation, from the same
 * session that produced the `bgFetch` truncation bug: a URL used as an image
 * returned `text/html` (a site root, 250 000 characters) and the proxy base64'd
 * the whole page into a data URL that could never render as an `<img>`.
 *
 * `image/svg+xml` is deliberately allowed through the MIME check — the adapter
 * already requests it, and an `<img src="data:image/svg+xml;base64,…">` cannot
 * execute script in the page (no scripting context), so the usual SVG hazard does
 * not apply on this path.
 */
function isImageMime(contentType: string): boolean {
  const mime = (contentType.split(';')[0] || '').trim().toLowerCase();
  return mime.startsWith('image/');
}

/**
 * Read at most `MAX_IMAGE_BYTES`, reporting whether the body was cut.
 *
 * Streams rather than `arrayBuffer()` so an oversized response is never
 * materialized: the point is to not pay for the bytes, not merely to discard them
 * afterwards.
 */
async function readImageCapped(res: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const whole = new Uint8Array(await res.arrayBuffer());
    return whole.length > MAX_IMAGE_BYTES
      ? { bytes: whole.slice(0, MAX_IMAGE_BYTES), truncated: true }
      : { bytes: whole, truncated: false };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_IMAGE_BYTES) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  const bytes = new Uint8Array(total > MAX_IMAGE_BYTES ? MAX_IMAGE_BYTES : total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset + chunk.length > bytes.length) {
      bytes.set(chunk.subarray(0, bytes.length - offset), offset);
      break;
    }
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, truncated };
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
 *  - `{ ok: false, error }` naming the ceiling when the body was not an image or
 *    was too large to be one
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

      // Enforce both ceilings BEFORE reading the body: a response that is not an
      // image, or is larger than any image should be, is refused rather than
      // downloaded and then discarded.
      const contentType = res.headers.get('content-type') || '';
      if (!isImageMime(contentType)) {
        devLog.warn(
          'proxyImage',
          `${target.hostname} 返回的不是图片`,
          `Content-Type: ${contentType || '（缺失）'}；已拒绝，避免把整页内容编码进 data URL`,
        );
        sendResponse({
          ok: false,
          status: res.status,
          error: `该地址返回的不是图片（${contentType || '无 Content-Type'}）`,
        });
        return;
      }

      const { bytes, truncated } = await readImageCapped(res);
      if (truncated) {
        devLog.warn(
          'proxyImage',
          `${target.hostname} 图片超过上限`,
          `已超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB，已截断并放弃`,
        );
        sendResponse({
          ok: false,
          status: res.status,
          error: `图片超过上限（${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB）`,
        });
        return;
      }

      const mimeType = contentType.split(';')[0] || 'image/jpeg';
      let binary = '';
      const chunkSize = 8192;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize) as unknown as number[]);
      }
      const base64 = btoa(binary);
      const dataUrl = `data:${mimeType};base64,${base64}`;

      sendResponse({ ok: true, dataUrl });
    } catch (err: unknown) {
      // The Developer Log panel is the surface a user can actually send us
      // (rules 11/20); a console line is invisible to it. Same defect class as
      // the adapters' console-only diagnostics.
      devLog.error('proxyImage', '图片代理异常', errorMessage(err, 'Proxy image error'));
      sendResponse({ ok: false, error: errorMessage(err, 'Proxy image error') });
    }
  })();
  return true;
}
