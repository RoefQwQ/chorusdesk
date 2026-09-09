/**
 * Handles FETCH_DOUYIN_SNAPSHOT: scrapes a Douyin creator page from a real
 * douyin.com tab via `chrome.scripting.executeScript`.
 *
 * Why a tab and not `bgFetch`: a background fetch of a creator page returns an
 * anti-bot JS challenge shell with no post data at all (see `contract.ts`). The
 * page must actually execute, so the only workable path is the one
 * `twitterTimeline.ts` already established — inject into a page context.
 *
 * Message contract:
 *   in:  { type: 'FETCH_DOUYIN_SNAPSHOT', secUid, limit? }
 *   out: { success: true, snapshot } | { success: false, error, code }
 *
 * The caller is pinned to an extension page by the router's SENDER_POLICY; this
 * handler additionally verifies that the tab it scrapes is genuinely on
 * douyin.com (hostname match, never a substring — AGENTS rule 1).
 */
import { collectDouyinSnapshot, deepCollectDouyinSnapshot } from '../../../adapters/douyin/collector';
import { MAX_ITEMS_PER_SNAPSHOT } from '../../../adapters/douyin/contract';
import { hostMatches } from './hosts';

interface DouyinSnapshotMessage {
  type: 'FETCH_DOUYIN_SNAPSHOT';
  secUid?: unknown;
  limit?: unknown;
  /** When true, scroll the grid to pull in older works before scraping. */
  deep?: unknown;
}

type SendResponse = (response?: unknown) => void;

/** Failure classes this handler reports; mapped to FetchError codes by the adapter. */
export type DouyinSnapshotErrorCode = 'auth' | 'network' | 'parse' | 'unsupported' | 'rate_limit';

/** Douyin `sec_uid`s are base64url-ish tokens; reject anything else outright. */
const SEC_UID_RE = /^[A-Za-z0-9_-]{6,200}$/;

/** True when `url` is an http(s) URL whose host is douyin.com or a subdomain. */
export function isDouyinTabUrl(url: unknown): boolean {
  if (typeof url !== 'string' || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  // Live is explicitly out of scope for V1 and must not be scraped as a profile.
  if (hostMatches(parsed.hostname, 'live.douyin.com')) return false;
  return hostMatches(parsed.hostname, 'douyin.com');
}

/**
 * Handles FETCH_DOUYIN_SNAPSHOT. Returns `true` to keep the message channel open
 * for the async `sendResponse` — callers MUST return this from the listener.
 */
export function handleDouyinSnapshot(
  message: DouyinSnapshotMessage,
  sendResponse: SendResponse,
): boolean {
  (async () => {
    const fail = (code: DouyinSnapshotErrorCode, error: string) =>
      sendResponse({ success: false, code, error });

    try {
      const secUid = typeof message.secUid === 'string' ? message.secUid.trim() : '';
      if (!SEC_UID_RE.test(secUid)) {
        fail('unsupported', '抖音创作者标识无效');
        return;
      }
      const limit = Math.min(
        Math.max(Number(message.limit) || 20, 1),
        MAX_ITEMS_PER_SNAPSHOT,
      );

      if (!chrome.tabs || !chrome.scripting) {
        fail('unsupported', 'Background 缺少 tabs 或 scripting 权限');
        return;
      }

      const profileUrl = `https://www.douyin.com/user/${secUid}`;
      const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);

      // Prefer a tab already showing THIS creator, then any douyin.com tab we can
      // navigate. Never open a Douyin tab unprompted on a timer: repeatedly
      // loading profile pages in the background is exactly what trips Douyin's
      // rate limiting, and auto-sync must not do it.
      const exact = tabs.find((t) => t.id && typeof t.url === 'string' && t.url.includes(secUid) && isDouyinTabUrl(t.url));
      const anyDouyin = tabs.find((t) => t.id && isDouyinTabUrl(t.url));
      const target = exact || anyDouyin;

      if (!target?.id) {
        fail(
          'auth',
          '未找到已打开的抖音页面。请在浏览器中打开该创作者主页（douyin.com）后再同步，抖音的作品列表只能在真实页面中加载。',
        );
        return;
      }

      // Re-read the tab: `tabs.query` results can be stale, and we must not
      // inject into a tab that has navigated elsewhere in the meantime.
      const live = await chrome.tabs.get(target.id).catch(() => null);
      if (!live || !isDouyinTabUrl(live.url)) {
        fail('auth', '抖音标签页已跳转到其他站点，请重新打开抖音创作者主页后再同步。');
        return;
      }

      // Only navigate when the tab is not already on the wanted creator; a
      // same-page scrape is cheaper and does not disturb the user's browsing.
      const onTargetCreator = typeof live.url === 'string' && live.url.includes(secUid);
      if (!onTargetCreator) {
        await chrome.tabs.update(target.id, { url: profileUrl }).catch(() => null);
        await waitForTabLoad(target.id, profileUrl);
      }

      const confirmed = await chrome.tabs.get(target.id).catch(() => null);
      if (!confirmed || !isDouyinTabUrl(confirmed.url)) {
        fail('auth', '抖音页面加载失败，请手动打开该创作者主页后再同步。');
        return;
      }

      const deep = message.deep === true;
      const injected = deep
        ? await chrome.scripting.executeScript({
            target: { tabId: target.id },
            func: deepCollectDouyinSnapshot,
            // Scroll rounds are bounded so a dig cannot spin forever against a
            // grid that is gated rather than finished.
            args: [limit, 40],
          })
        : await chrome.scripting.executeScript({
            target: { tabId: target.id },
            func: collectDouyinSnapshot,
            args: [limit],
          });

      const snapshot = injected?.[0]?.result;
      if (!snapshot || typeof snapshot !== 'object') {
        fail('parse', '抖音页面未返回可解析的作品数据。');
        return;
      }

      const shot = snapshot as ReturnType<typeof collectDouyinSnapshot>;
      if (shot.requiresVerify) {
        fail('rate_limit', '抖音页面出现安全验证。请在抖音标签页中完成验证后再同步。');
        return;
      }
      if (shot.requiresAuth) {
        fail('auth', '抖音页面要求登录或该创作者不可见。请在抖音标签页中确认页面可正常浏览。');
        return;
      }
      if (shot.gridError) {
        fail('rate_limit', '抖音作品列表加载失败（页面提示服务异常）。请稍后在抖音页面刷新后再同步。');
        return;
      }

      sendResponse({ success: true, snapshot: shot });
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : String(err);
      fail('network', `抖音页面采集异常: ${messageText}`);
    }
  })();
  return true;
}

/** Wait (bounded) for a tab to finish loading the creator page. */
function waitForTabLoad(tabId: number, _url: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      // Douyin's grid is client-rendered after load; give it a moment to paint.
      setTimeout(resolve, 2500);
    };
    const timer = setTimeout(finish, 12_000);
    function onUpdated(id: number, info: { status?: string }) {
      if (id === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
