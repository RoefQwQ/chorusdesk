/**
 * The xiaohongshu profile collector handler.
 *
 * Message contract:
 *   in:  { type: 'FETCH_XHS_NOTES', userId, limit?, deep? }
 *   out: { success: true, snapshot } | { success: false, code, error }
 *
 * ## Why this exists at all
 *
 * A profile page's SSR document carries only its first screen (~30 notes), and the
 * endpoint that would page it (`/api/sns/web/v1/user_posted`) needs an `X-S`
 * signature only the page's own JS produces — a route
 * `docs/DOUYIN_RESEARCH_2026-09.md` explicitly excludes. So reaching older notes
 * means running in a page and letting its own loader fetch them.
 *
 * ## `world: 'MAIN'`, and why this handler differs from the Douyin one
 *
 * The collector reads `window.__INITIAL_STATE__`. That object belongs to the PAGE's
 * JavaScript world; an isolated-world content script sees a different `window` and
 * would find it undefined. So this injection MUST specify `world: 'MAIN'` — the
 * default (`ISOLATED`) silently yields "no notes" rather than an error, which is
 * the kind of failure that looks like an empty account. Reading the state is also
 * why the collector needs no signature and touches no device identifiers: it only
 * reads what the page already loaded for the user.
 *
 * ## The user's account is what pays for this
 *
 * Scrolling is what triggers the platform's automation heuristics, and the
 * reference implementation (JoeanAmier/XHS-Downloader) ships it **off by default**
 * with a risk warning. That is why this is reached ONLY from the dashboard's
 * deep-sync flow, which warns first, and never from auto-sync (a timer must not
 * take that risk on the user's behalf).
 */
import { errorMessage } from '../../../utils/errorMessage';
import { devLog } from '../../../utils/devLog';
import { collectXhsProfileNotes } from '../../../adapters/xiaohongshu/collector';
import type { XhsProfileSnapshot } from '../../../adapters/xiaohongshu/collector';

export interface XhsNotesMessage {
  type: 'FETCH_XHS_NOTES';
  userId?: string;
  limit?: number;
  /** Scroll for older notes. False = read only what the page already holds. */
  deep?: boolean;
}

type SendResponse = (response: Record<string, unknown>) => void;

export type XhsNotesErrorCode = 'auth' | 'network' | 'parse' | 'unsupported' | 'rate_limit';

/** A xiaohongshu user id: 24 hex characters on the profile URL. */
const USER_ID_RE = /^[0-9a-fA-F]{24}$/;
/** Hard ceiling on what one collection returns. */
const MAX_ITEMS_PER_COLLECTION = 2000;
/** Scroll rounds one dig may perform; bounds a gated feed that never finishes. */
const MAX_SCROLL_ROUNDS = 120;
/** How long an injection may take (page load + all scroll rounds) before giving up. */
const INJECT_DEADLINE_MS = 180_000;

/** Only a xiaohongshu profile page may be read. */
export function isXhsProfileTabUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!/(^|\.)xiaohongshu\.com$/.test(parsed.hostname)) return false;
    return /^\/user\/profile\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** `true` when the tab is showing a profile page for this exact user id. */
function isTabForUser(url: unknown, userId: string): boolean {
  return isXhsProfileTabUrl(url) && typeof url === 'string' && url.includes(userId);
}

interface InjectionOutcome<T = unknown> {
  ran: boolean;
  value?: T;
  error?: string;
}

/**
 * Inject and classify the outcome.
 *
 * A resolved `executeScript` is NOT evidence that anything ran: a tab that
 * navigates mid-injection resolves with **no result** because the frame is gone
 * (AGENTS rule 23). The collector always returns an object, so "produced no value"
 * is a reliable "did not run" here, and it is transient — the caller retries it.
 *
 * `func` may be sync or async: `executeScript` awaits a returned promise, so what
 * arrives in `result` is the settled value either way — hence the union in the
 * parameter, and `T` (not `T | Promise<T>`) in the outcome.
 */
async function injectAndAwait<T>(
  tabId: number,
  func: (...args: never[]) => T | Promise<T>,
  args: unknown[],
): Promise<InjectionOutcome<T>> {
  try {
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      func: func as (...args: unknown[]) => T,
      args,
      // The page's own state object lives in the MAIN world; an isolated-world
      // injection would not see it (see the header).
      world: 'MAIN',
    });
    const first = result?.[0];
    if (!first || first.result === undefined || first.result === null) {
      return { ran: false, error: '注入未返回结果（页面可能发生了跳转或重新渲染）' };
    }
    return { ran: true, value: first.result as T };
  } catch (err: unknown) {
    return { ran: false, error: errorMessage(err) };
  }
}

/**
 * Inject the collector, retrying the valueless case.
 *
 * Bounded by attempts AND by wall-clock: a page being re-rendered can lose several
 * injections in a row, and the retry must not outlast the caller's own budget.
 */
async function collectReliably(
  tabId: number,
  limit: number,
  deep: boolean,
): Promise<InjectionOutcome<XhsProfileSnapshot>> {
  const attempts = 3;
  const deadline = Date.now() + INJECT_DEADLINE_MS;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (Date.now() > deadline) {
      return { ran: false, error: '采集超过时间预算（页面可能在持续重载）' };
    }
    const args: unknown[] = [limit, deep ? MAX_SCROLL_ROUNDS : 0];
    const outcome = await injectAndAwait(tabId, collectXhsProfileNotes, args);
    if (outcome.ran) return outcome;
    lastError = outcome.error;
    if (attempt < attempts) {
      devLog.debug('xiaohongshu', '采集注入未完成，重试', `tab ${tabId}：${outcome.error ?? '未知原因'}`);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  return { ran: false, error: lastError };
}

/**
 * Handle a `FETCH_XHS_NOTES` message.
 *
 * Synchronous wrapper returning `true` so the message channel stays open for the
 * async reply — the shape every async handler in this directory uses.
 */
export function handleXhsNotes(
  message: XhsNotesMessage,
  sendResponse: SendResponse,
): boolean {
  (async () => {
    /** A tab this handler opened and must therefore close. */
    let tempTabId: number | undefined;

    const fail = (code: XhsNotesErrorCode, error: string) => ({ success: false, code, error });

    const scrape = async (): Promise<Record<string, unknown>> => {
      const userId = typeof message.userId === 'string' ? message.userId.trim() : '';
      if (!USER_ID_RE.test(userId)) {
        return fail('unsupported', '小红书用户标识无效（需要 24 位十六进制 id）。');
      }

      const limit = Math.min(
        Math.max(Number(message.limit) || 100, 1),
        MAX_ITEMS_PER_COLLECTION,
      );
      const deep = message.deep === true;

      if (!chrome.tabs || !chrome.scripting) {
        return fail('unsupported', 'Background 缺少标签页访问或脚本注入能力');
      }

      // Reuse a tab ONLY when it is already showing THIS user's profile: scraping
      // in place is free and disturbs nothing. Any other xiaohongshu tab belongs to
      // the user, and navigating it would move their page out from under them.
      const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
      const exact = tabs.find((t) => t.id && isTabForUser(t.url, userId));

      let targetId: number | undefined = exact?.id;
      let openedByUs = false;

      if (targetId === undefined) {
        const profileUrl = `https://www.xiaohongshu.com/user/profile/${userId}`;
        const created = await chrome.tabs.create({ url: profileUrl, active: false }).catch(() => null);
        if (!created?.id) {
          return fail('network', '未能打开小红书页面，请稍后重试。');
        }
        targetId = created.id;
        tempTabId = created.id;
        openedByUs = true;
        await waitForTabLoad(targetId);
      }

      const confirmed = await chrome.tabs.get(targetId).catch(() => null);
      if (!confirmed || !isTabForUser(confirmed.url, userId)) {
        // The observable fact is that the tab is no longer on the profile, whatever
        // it was moved to. That is a classification decision, not a wording one: a
        // login wall means the user must sign in, a redirect after a burst of
        // requests means the platform is asking us to stop (rule 19).
        const landedUrl = typeof confirmed?.url === 'string' ? confirmed.url : '';
        if (!confirmed) {
          return fail('network', '小红书页面已被关闭，未能完成采集。请重试。');
        }
        if (/\/login/.test(landedUrl)) {
          return fail('auth', '小红书要求登录，未登录的会话看不到创作者主页。请先在浏览器中登录小红书。');
        }
        return fail(
          'rate_limit',
          '小红书页面已跳转离开该创作者主页，通常是短时间请求过多触发了安全验证。请稍后再试（该平台会自动进入冷却）。',
        );
      }

      const collected = await collectReliably(targetId, limit, deep);
      if (!collected.ran) {
        return fail(
          'network',
          `小红书页面在采集过程中发生跳转或重新渲染，未能取得笔记数据：${collected.error ?? '未知原因'}。请稍后重试。`,
        );
      }

      const raw = collected.value;
      if (!raw || typeof raw !== 'object') {
        return fail('parse', '小红书页面未返回可解析的笔记数据。');
      }
      // The page payload is untrusted; the adapter validates it in `contract.ts`.
      // This only routes the two conditions the collector can detect itself.
      const snapshot = raw as { requiresLogin?: boolean; notes?: unknown[] };
      if (snapshot.requiresLogin === true) {
        return fail('auth', '小红书要求登录，未登录的会话看不到创作者主页。请先在浏览器中登录小红书。');
      }

      const noteCount = Array.isArray(snapshot.notes) ? snapshot.notes.length : 0;
      devLog.debug(
        'xiaohongshu',
        `采集完成：${noteCount} 条笔记${deep ? '（已滚动）' : ''}`,
        `tab ${targetId}${openedByUs ? '，临时页将关闭' : '，复用已打开页面'}`,
      );

      return { success: true, snapshot: raw };
    };

    let response: Record<string, unknown>;
    try {
      response = await scrape();
    } catch (err: unknown) {
      response = fail('network', `小红书采集异常: ${errorMessage(err)}`);
    } finally {
      // Close the throwaway tab BEFORE responding: `sendResponse` closes the
      // message channel, after which the worker may be torn down at any moment, so
      // an async `tabs.remove` scheduled after it may never run.
      if (tempTabId !== undefined) {
        try {
          await chrome.tabs.remove(tempTabId);
        } catch {
          // Already gone (the user closed it) or unreachable; nothing to do.
        }
      }
    }

    sendResponse(response);
  })();
  return true;
}

/** Bounded wait for a tab to finish loading. */
async function waitForTabLoad(tabId: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return;
    if (tab.status === 'complete') {
      // A short settle for the first paint; the collector re-reads the state each
      // round, so a slow render costs rounds rather than correctness.
      await new Promise((r) => setTimeout(r, 800));
      return;
    }
    if (Date.now() > deadline) return;
    await new Promise((r) => setTimeout(r, 300));
  }
}
