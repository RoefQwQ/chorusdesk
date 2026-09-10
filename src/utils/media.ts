import { devLog } from './devLog';

/**
 * Normalize a media/image URL so it is always an absolute, loadable https URL.
 * Also normalizes known CDN hotlink-sensitive domains to more permissive aliases.
 *
 * Bilibili (and other CDNs) frequently return protocol-relative URLs such as
 * "//i0.hdslb.com/bfs/face/...". Inside a chrome-extension:// page, a bare
 * "//host/path" resolves against the extension scheme (chrome-extension://host/...)
 * and the image breaks. Force an explicit https: scheme, and upgrade any legacy
 * http:// URL as well.
 *
 * Non-http(s) schemes (data:, blob:, relative paths) are returned unchanged.
 */
export function toSecureMediaUrl(url?: string | null): string {
  if (!url) return '';
  let trimmed = url.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('//')) {
    trimmed = `https:${trimmed}`;
  } else if (/^http:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^http:/i, 'https:');
  }

  // Normalize Xiaohongshu URLs without breaking paths
  if (
    trimmed.includes('xhscdn.com') ||
    trimmed.includes('xhscdn.net') ||
    trimmed.includes('xiaohongshu.com')
  ) {
    if (trimmed.includes('/avatar/')) {
      const m = trimmed.match(/\/avatar\/[a-zA-Z0-9_.-]+/);
      if (m) {
        return `https://sns-avatar-qc.xhscdn.com${m[0]}`;
      }
    }
  }

  return trimmed;
}

// In-memory cache for base64 / blob URLs proxied via background
const imageProxyCache = new Map<string, string>();
const pendingProxyFetches = new Map<string, Promise<string | null>>();

// Global cache for URLs that have definitively failed to load / proxy
const failedImageUrls = new Set<string>();

export function isImageFailed(url?: string | null): boolean {
  if (!url) return false;
  return failedImageUrls.has(url) || failedImageUrls.has(toSecureMediaUrl(url));
}

export function markImageFailed(url?: string | null): void {
  if (!url) return;
  failedImageUrls.add(url);
  const secureUrl = toSecureMediaUrl(url);
  if (secureUrl) failedImageUrls.add(secureUrl);
}

/**
 * Fetch an image through the background service worker using extension host permissions
 * and custom Referer / Origin headers, returning a base64 data URL.
 */
export async function proxyImage(url: string): Promise<string | null> {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const secureUrl = toSecureMediaUrl(url);

  // Check cache first
  if (imageProxyCache.has(secureUrl)) {
    return imageProxyCache.get(secureUrl)!;
  }
  if (imageProxyCache.has(url)) {
    return imageProxyCache.get(url)!;
  }

  // Deduplicate in-flight requests for the same image
  if (pendingProxyFetches.has(secureUrl)) {
    return pendingProxyFetches.get(secureUrl)!;
  }

  const fetchPromise = (async () => {
    const startedAt = performance.now();
    try {
      if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
        // First attempt with secureUrl
        let resp = await new Promise<{ ok: boolean; dataUrl?: string; error?: string }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'PROXY_IMAGE', url: secureUrl }, (res) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
            } else {
              resolve(res || { ok: false });
            }
          });
        });

        // If first attempt failed and original url is different, try original url as fallback
        if (!resp?.ok && secureUrl !== url) {
          resp = await new Promise<{ ok: boolean; dataUrl?: string; error?: string }>((resolve) => {
            chrome.runtime.sendMessage({ type: 'PROXY_IMAGE', url }, (res) => {
              if (chrome.runtime.lastError) {
                resolve({ ok: false, error: chrome.runtime.lastError.message });
              } else {
                resolve(res || { ok: false });
              }
            });
          });
        }

        // A proxy round trip is the slowest step in showing a hotlink-protected
        // image: it is a background fetch plus a base64 transfer back over the
        // message channel. Log it so "images take a second or two" can be
        // attributed to this stage instead of guessed at.
        const elapsed = Math.round(performance.now() - startedAt);
        const host = (() => {
          try { return new URL(secureUrl).hostname; } catch { return '未知主机'; }
        })();

        if (resp?.ok && resp.dataUrl) {
          imageProxyCache.set(secureUrl, resp.dataUrl);
          imageProxyCache.set(url, resp.dataUrl);
          devLog.debug('media', `图片代理 ${host} 成功 ${elapsed}ms`, `体积 ${Math.round(resp.dataUrl.length / 1024)}KB`);
          return resp.dataUrl;
        }
        devLog.warn('media', `图片代理 ${host} 失败 ${elapsed}ms`, resp?.error || '无响应');
      }
      markImageFailed(url);
      markImageFailed(secureUrl);
      return null;
    } catch {
      markImageFailed(url);
      markImageFailed(secureUrl);
      return null;
    } finally {
      pendingProxyFetches.delete(secureUrl);
    }
  })();

  pendingProxyFetches.set(secureUrl, fetchPromise);
  return fetchPromise;
}

