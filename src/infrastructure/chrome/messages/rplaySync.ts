import { hostMatches } from './hosts';
// Minimal local types for the SYNC_RPLAY_TOKEN runtime-message contract. They
// only describe what this handler reads / replies with — the protocol shape
// itself is unchanged (see entrypoints/popup/composables/useRplaySync.ts
// and entrypoints/dashboard/App.vue for the caller side).
interface SyncRplayTokenMessage {
  type: 'SYNC_RPLAY_TOKEN';
}

type SendResponse = (response?: unknown) => void;

/** Error-message extraction mirroring `err?.message || '提取凭证异常'`. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || '提取凭证异常';
  }
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = err.message;
    if (typeof message === 'string' && message) return message;
  }
  return '提取凭证异常';
}

/**
 * Handles SYNC_RPLAY_TOKEN messages: extracts the logged-in Rplay auth token
 * from the LocalStorage of an open rplay.live tab and stores it as
 * `rplay_auth_token` so later Rplay fetches can attach it.
 *
 * Lookup is two-stage: first query specifically for rplay.live tabs, then
 * fall back to scanning every tab's URL; the token itself is read by running
 * an in-page function that tries known keys and then a full auth-ish key scan.
 *
 * Responses:
 *  - `{ success: true, token }` when a token was found and stored
 *  - `{ success: false, error }` for missing permissions / tabs / token
 *
 * Returns `true` so the runtime message channel stays open until the async
 * sendResponse fires — callers MUST return this value from the listener.
 */
export function handleSyncRplayToken(message: SyncRplayTokenMessage, sendResponse: SendResponse): boolean {
  (async () => {
    try {
      if (!chrome.tabs || !chrome.scripting) {
        sendResponse({ success: false, error: 'Background 缺少 tabs 或 scripting 权限' });
        return;
      }

      // 1. Try querying specifically for rplay.live tabs, fallback to all tabs
      let tabs = await chrome.tabs.query({ url: ['*://*.rplay.live/*', 'https://rplay.live/*'] }).catch(() => []);
      if (!tabs || tabs.length === 0) {
        const allTabs = await chrome.tabs.query({}).catch(() => []);
        tabs = allTabs.filter((t) => {
          if (!t.url) return false;
          try {
            const { hostname } = new URL(t.url);
            return hostMatches(hostname, 'rplay.live');
          } catch {
            return false;
          }
        });
      }

      if (tabs.length === 0) {
        sendResponse({
          success: false,
          error: '未检测到已打开的 rplay.live 标签页。请先在浏览器中新建标签页打开 rplay.live 并确认已登录（也可以使用“手动粘贴”输入凭证）。',
        });
        return;
      }

      let token: string | null = null;
      for (const tab of tabs) {
        if (!tab.id) continue;
        try {
          const res = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => {
              const candidateKeys = [
                '_AUTHORIZATION_',
                'token',
                'pocketbase_auth',
                'auth_token',
                'accessToken',
                'auth',
              ];
              for (const k of candidateKeys) {
                const val = localStorage.getItem(k);
                if (val && val.length > 8) return val;
              }
              // Scan all keys
              for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && (k.toLowerCase().includes('auth') || k.toLowerCase().includes('token'))) {
                  const v = localStorage.getItem(k);
                  if (v && v.length > 8) return v;
                }
              }
              return null;
            },
          });

          if (res?.[0]?.result) {
            token = res[0].result;
            break;
          }
        } catch (scriptErr) {
          console.warn('[Background] Tab scripting error:', scriptErr);
        }
      }

      if (token) {
        await chrome.storage.local.set({ rplay_auth_token: token });
        sendResponse({ success: true, token });
      } else {
        sendResponse({
          success: false,
          error: '已检测到打开的 Rplay 页面，但在该页面 LocalStorage 中未找到有效登录 Token，请确认已在 rplay.live 登录。',
        });
      }
    } catch (err: unknown) {
      sendResponse({ success: false, error: errorMessage(err) });
    }
  })();
  return true; // Keep message channel open for async response
}
