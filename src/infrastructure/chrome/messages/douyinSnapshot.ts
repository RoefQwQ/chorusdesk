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
import { awaitDouyinGrid, collectDouyinSnapshot, deepCollectDouyinSnapshot } from '../../../adapters/douyin/collector';
import type { CollectedSnapshot } from '../../../adapters/douyin/collector';
import { MAX_ITEMS_PER_SNAPSHOT } from '../../../adapters/douyin/contract';
import { hostMatches } from './hosts';
import { devLog } from '../../../utils/devLog';

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
    /** A tab this handler opened and must therefore close. */
    let tempTabId: number | undefined;

    const fail = (code: DouyinSnapshotErrorCode, error: string) => ({ success: false, code, error });

    /**
     * The scrape itself, as a function that *returns* its response.
     *
     * It must not send the response directly: `sendResponse` closes the message
     * channel, after which the worker may be torn down at any moment — so the
     * throwaway tab has to be closed first, and every exit path has to funnel
     * through the cleanup below. (A `return` inside an outer `try` would skip
     * the code after the `finally`, which is exactly how the first version of
     * this fix managed to stop answering on its failure paths.)
     */
    const scrape = async (): Promise<Record<string, unknown>> => {
      const secUid = typeof message.secUid === 'string' ? message.secUid.trim() : '';
      if (!SEC_UID_RE.test(secUid)) return fail('unsupported', '抖音创作者标识无效');

      const limit = Math.min(
        Math.max(Number(message.limit) || 20, 1),
        MAX_ITEMS_PER_SNAPSHOT,
      );

      if (!chrome.tabs || !chrome.scripting) {
        return fail('unsupported', 'Background 缺少标签页访问或脚本注入能力');
      }

      const profileUrl = `https://www.douyin.com/user/${secUid}`;
      const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);

      // Reuse an existing tab ONLY when it is already showing this very creator:
      // scraping in place is free and disturbs nothing. Any other douyin tab
      // belongs to the user, and navigating it would move their page out from
      // under them — a tab that is mid-navigation also briefly reports a stale
      // or empty `url`, which is how the previous "navigate it" strategy ended up
      // creating and closing an extra tab on a later channel of the same batch.
      // So: matching tab in place, otherwise a throwaway tab of our own.
      const exact = tabs.find(
        (t) => t.id && typeof t.url === 'string' && t.url.includes(secUid) && isDouyinTabUrl(t.url),
      );

      // Probe for the one open question this path depends on: without the `tabs`
      // permission, does `tabs.query` still hand back URLs for pages we hold host
      // permission for? If it does not, `url` is undefined, every lookup falls
      // through to "no tab found", and both Douyin and Twitter tab targeting
      // break. Log the counts so a single sync answers it instead of a guess.
      const douyinTabs = tabs.filter((t) => isDouyinTabUrl(t.url));
      const urlsReadable = douyinTabs.filter((t) => typeof t.url === 'string' && t.url.length > 0).length;
      devLog.debug(
        'douyin',
        `标签页扫描：共 ${tabs.length} 个，抖音 ${douyinTabs.length} 个，其中 URL 可读 ${urlsReadable} 个`,
        tabs.length > 0 && douyinTabs.length === 0
          ? '⚠ 未识别出抖音页；若确实开着抖音页，说明 tabs.query 在无 tabs 权限下不返回 URL'
          : undefined,
      );

      let targetId: number | undefined = exact?.id;

      if (targetId === undefined) {
        // Nothing to reuse: open our own. Safe to do unconditionally here because
        // this handler is only ever reached from a user-initiated page action —
        // auto-sync runs in the service worker, where the douyin adapter refuses
        // before messaging (a timer must never load profile pages on its own).
        const created = await chrome.tabs.create({ url: profileUrl, active: false }).catch(() => null);
        if (!created?.id) {
          return fail('auth', '未能打开抖音页面。请在浏览器中打开任意抖音页面后再试。');
        }
        targetId = created.id;
        tempTabId = created.id;
        // Record it before doing anything slow, so a worker death during the
        // load wait still leaves a trail the sweep can follow.
        await rememberTempTab(created.id);
        await waitForTabLoad(targetId);
      }

      const confirmed = await chrome.tabs.get(targetId).catch(() => null);
      if (!confirmed || !isDouyinTabUrl(confirmed.url)) {
        return fail('auth', '抖音页面加载失败，请在浏览器中打开任意抖音页面后再试。');
      }

      // The tab's load event is not the grid being on screen. Wait for the works
      // to actually render before scraping, or a cold page yields an empty grid
      // and the collector can only report "no works" for a creator that has them.
      const probe = await probeDouyinGrid(targetId);

      if (!probe.ran) {
        devLog.warn('douyin', '网格探针始终未能完成，仍尝试采集', `tab ${targetId}：${probe.error ?? '未知原因'}`);
      } else if (probe.value !== true) {
        // The probe ran and reported the grid genuinely did not appear in time.
        devLog.warn('douyin', '作品网格在等待时间内未渲染，仍尝试采集', `tab ${targetId}`);
      }

      // Either failure mode lands here, because both raise the same question and
      // it has one answer: where is the tab now?
      //
      // Douyin answers a burst of requests with a verification redirect, and the
      // in-flight injection then dies with a frame error rather than a verdict —
      // observed as `Frame with ID 0 was removed` from a *network* classification,
      // which told the user nothing and, worse, suppressed the rate-limit signal
      // the sync layer needs in order to back off. The observable fact is simply
      // that the tab is no longer on the creator's profile, whatever it was moved
      // to (captcha, login wall, error page).
      if (!probe.ran || probe.value !== true) {
        const landed = await chrome.tabs.get(targetId).catch(() => null);
        if (!landed) {
          return fail('auth', '抖音页面已被关闭，未能完成采集。请重试。');
        }
        const landedUrl = typeof landed.url === 'string' ? landed.url : '';
        if (!landedUrl.includes(secUid)) {
          return fail(
            'rate_limit',
            '抖音页面已跳转离开该创作者主页，通常是短时间请求过多触发了安全验证。请先在抖音标签页中完成验证，稍后再同步（该平台会自动进入冷却）。',
          );
        }
      }

      const deep = message.deep === true;
      const collected = deep
        ? await collectDouyinSnapshotReliably(targetId, deepCollectDouyinSnapshot, [
            limit,
            // Scroll rounds are bounded so a dig cannot spin forever against a
            // grid that is gated rather than finished.
            40,
          ])
        : await collectDouyinSnapshotReliably(targetId, collectDouyinSnapshot, [limit]);

      if (!collected.ran) {
        // Not "the page has no works" — the script never finished running.
        return fail(
          'network',
          `抖音页面在采集过程中发生跳转或重新渲染，未能取得作品数据：${collected.error ?? '未知原因'}。请稍后重试。`,
        );
      }

      // The page payload is untrusted; the adapter normalizes it. This only
      // checks that something object-shaped came back.
      const raw = collected.value;
      if (!raw || typeof raw !== 'object') {
        return fail('parse', '抖音页面未返回可解析的作品数据。');
      }
      const shot = raw as CollectedSnapshot;
      if (shot.requiresVerify) {
        return fail('rate_limit', '抖音页面出现安全验证。请在抖音标签页中完成验证后再同步。');
      }
      if (shot.requiresAuth) {
        return fail('auth', '抖音页面要求登录或该创作者不可见。请在抖音标签页中确认页面可正常浏览。');
      }
      if (shot.gridError) {
        return fail('rate_limit', '抖音作品列表加载失败（页面提示服务异常）。请稍后在抖音页面刷新后再同步。');
      }

      return { success: true, snapshot: shot };
    };

    let response: Record<string, unknown>;
    try {
      response = await scrape();
    } catch (err: unknown) {
      const messageText = err instanceof Error ? err.message : String(err);
      response = fail('network', `抖音页面采集异常: ${messageText}`);
    } finally {
      // Close the throwaway tab BEFORE responding. `sendResponse` closes the
      // message channel, and once it is closed the service worker may be torn
      // down immediately — a `finally` that runs after it cannot be relied on to
      // finish an async `tabs.remove`, which is how a sync left its temporary
      // Douyin tab open.
      if (tempTabId !== undefined) {
        // The record is cleared ONLY when the tab is really gone. Clearing it
        // after a failed `tabs.remove` would strand the tab: the sweep would have
        // nothing left to find, which is how a leftover survived the earlier fix.
        let closed = false;
        try {
          await chrome.tabs.remove(tempTabId);
          closed = true;
        } catch (e: unknown) {
          // A failed remove usually means the tab is already gone (the user closed
          // it), which is fine — distinguish that from a real failure.
          const stillOpen = await chrome.tabs.get(tempTabId).catch(() => null);
          closed = !stillOpen;
          if (!closed) {
            devLog.warn(
              'douyin',
              `临时标签页未能关闭（tab ${tempTabId}），已登记待下次启动回收`,
              String(e),
            );
          }
        }
        if (closed) {
          await forgetTempTab();
          devLog.debug('douyin', `已关闭抖音临时页（tab ${tempTabId}）`);
        }
      }
    }

    sendResponse(response);
  })();
  return true;
}

/** Key under which an in-flight temporary Douyin tab is recorded. */
const TEMP_TAB_KEY = 'douyin.tempTabId';
/**
 * A scrape (page load + paint wait + inject) is bounded well under this. An
 * entry older than this belongs to a run that died rather than one in flight, so
 * sweeping it cannot close a tab another sync is still using.
 */
const TEMP_TAB_STALE_MS = 60_000;

/**
 * Record the throwaway tab so it can be reclaimed if this worker dies before it
 * finishes. `chrome.storage.session` survives a worker teardown (it lives for the
 * browser session), which is exactly the window where an in-memory id is lost.
 */
async function rememberTempTab(id: number): Promise<void> {
  try {
    await chrome.storage.session?.set({ [TEMP_TAB_KEY]: { id, at: Date.now() } });
  } catch {
    // Recording is best-effort; the in-memory id still covers the normal path.
  }
}

async function forgetTempTab(): Promise<void> {
  try {
    await chrome.storage.session?.remove(TEMP_TAB_KEY);
  } catch {
    // Same: nothing to do if the area is unavailable.
  }
}

/**
 * Close a throwaway Douyin tab left behind by an earlier run.
 *
 * The in-line cleanup in the handler covers the normal case, but a service
 * worker can be torn down mid-scrape — and then an in-memory `setTimeout` and its
 * `tabs.remove` go with it, leaving the tab open with nothing left to close it.
 * This is the backstop for that window. Safe to call at any time: it only ever
 * touches a tab this extension opened for a scrape and left recorded for over a
 * minute, so an in-flight sync's own tab is never a candidate.
 */
export async function sweepOrphanDouyinTempTab(): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage?.session || !chrome.tabs) return;
  try {
    const stored = await chrome.storage.session.get(TEMP_TAB_KEY);
    const entry = stored?.[TEMP_TAB_KEY] as { id?: number; at?: number } | undefined;
    if (!entry || typeof entry.id !== 'number') return;

    if (typeof entry.at === 'number' && Date.now() - entry.at < TEMP_TAB_STALE_MS) {
      // Probably the scrape currently running: leave it alone.
      return;
    }

    // Only ever consider a tab this extension opened for a scrape. The record is
    // written solely in the branch that created the tab — a sync that reuses the
    // user's own Douyin tab never records anything, so it is not a candidate
    // here. (`chrome.storage.session` also dies with the browser session, and tab
    // ids are unique for that session's lifetime, so a recorded id cannot end up
    // pointing at a tab the user opened later.)
    const tab = await chrome.tabs.get(entry.id).catch(() => null);

    // Never touch the tab the user is currently looking at. This is the guard
    // for the one case id bookkeeping cannot rule out: our throwaway tab being
    // adopted as someone's browsing tab.
    if (tab?.active) {
      await forgetTempTab();
      return;
    }

    // Navigated away from Douyin: it belongs to the user now, so drop only the
    // record.
    if (!tab || !isDouyinTabUrl(tab.url)) {
      await forgetTempTab();
      return;
    }

    let closed = false;
    try {
      await chrome.tabs.remove(entry.id);
      closed = true;
    } catch {
      // Keep the record: the next startup retries rather than stranding the tab.
    }
    if (closed) {
      await forgetTempTab();
      devLog.info('douyin', `已回收上次同步遗留的抖音临时页（tab ${entry.id}）`);
    }
  } catch {
    // Sweeping is opportunistic; a failure just leaves it for the next attempt.
  }
}

/** How long the in-page probe waits for the grid before reporting "not ready". */
const GRID_WAIT_MS = 10_000;

/** Bounded attempts for an injection the page's own navigation destroyed. */
const INJECT_ATTEMPTS = 3;

/** Pause between attempts, long enough for a frame swap to settle. */
const INJECT_RETRY_DELAY_MS = 700;

/**
 * The outcome of one injection.
 *
 * `ran: false` means the script did not complete — the frame it was running in
 * went away. That is different in kind from a script that ran and reported an
 * answer, and the difference is what a retry keys on.
 */
interface InjectionOutcome {
  ran: boolean;
  /** Whatever the injected function returned; validated by its consumer. */
  value?: unknown;
  error?: string;
}

/**
 * Inject `func` and report whether it actually completed.
 *
 * A destroyed frame does not reliably surface as a rejection. Measured on a real
 * sync: the grid probe reported "not rendered" **3.5 s** into a 10 s deadline,
 * which the probe itself cannot do — it only returns `false` at the deadline. The
 * call had resolved with a non-boolean result, i.e. the script never finished,
 * and treating "resolved" as "ran" made the page's own navigation look like a
 * verdict about the page.
 *
 * So: an injection has run only if it produced a value of the expected kind. The
 * functions injected here always return a boolean or an object, so anything else
 * means the frame changed under them.
 */
async function injectAndAwait<T>(
  tabId: number,
  func: (...args: never[]) => T,
  args: unknown[],
): Promise<InjectionOutcome> {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as (...args: unknown[]) => T,
      args,
    });
    const first = result?.[0];
    if (!first || first.result === undefined || first.result === null) {
      return { ran: false, error: '注入未返回结果（页面可能发生了跳转或重新渲染）' };
    }
    // `executeScript` awaits a promise the injected function returns, so what
    // arrives is the awaited value (this is how the grid probe reports at all).
    return { ran: true, value: first.result };
  } catch (err: unknown) {
    return { ran: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Wait for the grid to render, retrying an injection the page destroyed.
 *
 * `ready: false, ran: true` is a real answer — the page loaded and the grid is not
 * there (a captcha, an auth wall, a genuinely slow render). `ran: false` is a
 * transient condition a retry routinely fixes, and must never be read as a
 * verdict about the page.
 */
async function probeDouyinGrid(tabId: number): Promise<InjectionOutcome> {
  let outcome = await injectAndAwait(tabId, awaitDouyinGrid, [GRID_WAIT_MS]);
  for (let attempt = 1; attempt < INJECT_ATTEMPTS && !outcome.ran; attempt++) {
    devLog.debug(
      'douyin',
      `网格探针未完成，重试 ${attempt}/${INJECT_ATTEMPTS - 1}`,
      `tab ${tabId}：${outcome.error ?? '未知原因'}`,
    );
    await new Promise((resolve) => setTimeout(resolve, INJECT_RETRY_DELAY_MS));
    outcome = await injectAndAwait(tabId, awaitDouyinGrid, [GRID_WAIT_MS]);
  }
  return outcome;
}

/**
 * Scrape the page, retrying an injection the page destroyed.
 *
 * The collector always returns an object — an empty one for an empty grid — so a
 * missing result is never data. It is the same transient frame swap, and it is
 * what made a channel whose probe had already failed report "no parseable works"
 * with nothing to distinguish it from a genuinely empty profile.
 */
async function collectDouyinSnapshotReliably(
  tabId: number,
  // Both collectors are accepted; their return types differ only in that the deep
  // one is async, and `executeScript` awaits it either way.
  func: (...args: never[]) => CollectedSnapshot | Promise<CollectedSnapshot>,
  args: unknown[],
): Promise<InjectionOutcome> {
  let outcome = await injectAndAwait(tabId, func, args);
  for (let attempt = 1; attempt < INJECT_ATTEMPTS && !outcome.ran; attempt++) {
    devLog.debug(
      'douyin',
      `采集注入未完成，重试 ${attempt}/${INJECT_ATTEMPTS - 1}`,
      `tab ${tabId}：${outcome.error ?? '未知原因'}`,
    );
    await new Promise((resolve) => setTimeout(resolve, INJECT_RETRY_DELAY_MS));
    outcome = await injectAndAwait(tabId, func, args);
  }
  return outcome;
}

/** Wait (bounded) for a tab to finish loading the creator page. */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      // A short settle for the initial paint; `awaitDouyinGrid` is what actually
      // gates readiness, so this no longer has to be generous.
      setTimeout(resolve, 800);
    };
    const timer = setTimeout(finish, 12_000);
    function onUpdated(id: number, info: { status?: string }) {
      if (id === tabId && info.status === 'complete') finish();
    }
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}
