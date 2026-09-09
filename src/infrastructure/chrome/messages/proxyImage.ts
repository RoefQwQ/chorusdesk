import { toSecureMediaUrl } from '../../../utils/media';

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
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        sendResponse({ ok: false, error: 'Invalid URL' });
        return;
      }
      const allowedHost = /(^|\.)((bilibili\.com|hdslb\.com|twimg\.com|x\.com|twitter\.com|pximg\.net|pixiv\.net|fantia\.jp|withny\.fun|xhscdn\.com|xhscdn\.net|xiaohongshu\.com|sinaimg\.cn|weibo\.com|weibo\.cn|youtube\.com))$/i.test(parsedUrl.hostname);
      if (!['http:', 'https:'].includes(parsedUrl.protocol) || !allowedHost || parsedUrl.username || parsedUrl.password) {
        sendResponse({ ok: false, error: 'Image host is not allowed' });
        return;
      }

      const isXhs = url.includes('xhscdn.com') || url.includes('xiaohongshu.com') || url.includes('xhscdn.net');
      let referer = 'https://www.xiaohongshu.com/';
      let origin = 'https://www.xiaohongshu.com';
      if (url.includes('sinaimg.cn') || url.includes('weibo.com')) {
        referer = 'https://weibo.com/';
        origin = 'https://weibo.com';
      } else if (url.includes('pximg.net') || url.includes('pixiv.net')) {
        referer = 'https://www.pixiv.net/';
        origin = 'https://www.pixiv.net';
      } else if (url.includes('bilibili.com') || url.includes('hdslb.com')) {
        referer = 'https://www.bilibili.com/';
        origin = 'https://www.bilibili.com';
      }

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
        } catch {}
      }

      let res: Response | null = null;
      let lastStatus = 0;

      for (const targetUrl of urlsToTry) {
        try {
          const fetchOptions: RequestInit = {
            method: 'GET',
            headers: {
              Referer: referer,
              Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
            },
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
          // Try next candidate
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
