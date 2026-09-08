import { performBgFetch } from '../infrastructure/chrome/messages/bgFetch';
import { IS_SERVICE_WORKER } from './runtime';

export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  data: string;
  error?: string;
}

/**
 * Universal cross-origin GET for Chrome Extension MV3.
 *
 * Two execution modes:
 *  - Inside the service worker (alarms / auto-sync): calls `performBgFetch`
 *    directly. `chrome.runtime.sendMessage` is NEVER delivered to listeners in
 *    the sending context, so messaging ourselves would just produce
 *    `runtime.lastError` — this was why background auto-sync failed for every
 *    platform before the alarm fix.
 *  - Inside an extension page (dashboard / popup): sends BG_FETCH to the
 *    service worker, which performs the CORS-exempt fetch under the sender
 *    policy in `entrypoints/background.ts`.
 *
 * Credentials are decided by the background, not the caller: platform hosts
 * get `credentials: 'include'`, everything else (arbitrary RSS feed URLs)
 * `'omit'`. Callers cannot request POST or inject credentials — every adapter
 * call site is a read.
 */
export async function bgFetch(url: string, options: RequestInit = {}): Promise<HttpResponse> {
  // Convert headers if passed as Headers instance
  let headersObj: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((v, k) => {
        headersObj[k] = v;
      });
    } else if (Array.isArray(options.headers)) {
      options.headers.forEach(([k, v]) => {
        headersObj[k] = v;
      });
    } else {
      headersObj = { ...(options.headers as Record<string, string>) };
    }
  }

  // 1. Already inside the service worker: execute the fetch directly.
  if (IS_SERVICE_WORKER) {
    return performBgFetch(url, headersObj);
  }

  // 2. Extension page: delegate to the service worker (CORS-exempt).
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    try {
      const resp = await new Promise<HttpResponse | null>((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'BG_FETCH',
            url,
            options: {
              headers: headersObj,
            },
          },
          (res) => {
            if (chrome.runtime.lastError) {
              console.warn('[bgFetch] runtime.lastError:', chrome.runtime.lastError.message);
              resolve(null);
            } else {
              resolve(res as HttpResponse | null);
            }
          }
        );
      });

      if (resp && typeof resp.ok === 'boolean') {
        return resp;
      }
    } catch (e) {
      console.warn('[bgFetch] Delegate failed:', e);
      return { ok: false, status: 0, data: '', error: '后台请求服务未响应，请重新加载扩展后重试' };
    }
  }

  // Only use direct fetch outside an extension context (for local unit/smoke use).
  if (typeof chrome !== 'undefined') {
    return { ok: false, status: 0, data: '', error: '扩展后台请求不可用' };
  }

  // Direct fetch fallback for non-extension callers.
  try {
    const res = await fetch(url, options);
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      data: text,
    };
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : '';
    return {
      ok: false,
      status: 0,
      data: '',
      error: message || '网络请求失败 (CORS或断网)',
    };
  }
}
