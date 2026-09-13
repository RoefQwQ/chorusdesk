/**
 * declarativeNetRequest dynamic rule initialization: hotlink-bypass rules for
 * image/media hosts.
 *
 * Every rule is scoped with `initiatorDomains: [chrome.runtime.id]` so the
 * header rewrite / scheme upgrade applies ONLY to requests initiated by this
 * extension (service-worker fetches, dashboard, popup). Without it, the rules
 * matched any tab the user visits — including pages that embed sinaimg/xhscdn
 * images, where our Referer rewrite silently degrades their loading — and
 * `sub_frame` extended that to embedded frames. For MV3, requests the service
 * worker makes itself carry the extension origin (chrome-extension://<id>) as
 * initiator, which is what the image proxies actually need.
 *
 * The rules are a TABLE, not six hand-written literals, because the pieces that
 * had to agree were written twice: each rule body carried its own `id`, and the
 * same six numbers were repeated in `removeRuleIds`. An id edited in one place
 * and not the other is invisible — the removal silently misses, the rule
 * accumulates, and nothing fails. Now both derive from `MEDIA_HEADER_RULES`.
 *
 * The row shape also makes the SECURITY property (every rule scoped to this
 * extension) assertable, which it was not when each rule spelled out its own
 * `condition`: `tests/declarativeNetRequest.test.ts` checks it per rule, so a
 * seventh rule cannot be added without it.
 *
 * Reapplying the same rule ids is idempotent (remove then add), so this is
 * safe to call on startup, install, or browser restart.
 *
 * @types/chrome@0.2.9 lacks `modifyHeaders` / `set` and several resourceTypes
 * literals, hence the localized casts — they stay until the types catch up.
 */

/** Resource types a media rule applies to: the display path plus our own fetches. */
const MEDIA_RESOURCE_TYPES = ['image', 'media', 'xmlhttprequest'];

/**
 * One header rewrite: a host pattern and the headers to set on requests for it.
 *
 * `urlFilter` is the Chrome DNR substring/`*` syntax, not a URL glob — it is
 * matched against the full request URL by the browser, which is why these read
 * like `*xhscdn.com*`. The host is deliberately NOT re-parsed here: DNR evaluates
 * the filter, so tightening it would mean changing the filter string itself.
 */
interface MediaHeaderRule {
  /** Stable dynamic-rule id. Never reused for a different host — see `ruleIds`. */
  id: number;
  /** Why this rule exists, for the log and for whoever edits it next. */
  note: string;
  /** DNR `urlFilter`. */
  urlFilter: string;
  /** Headers to set. The first key is the Referer, which every rule sets. */
  headers: Record<string, string>;
  /** `upgradeScheme` instead of a header rewrite (mixed-content fix). */
  upgradeScheme?: boolean;
}

/**
 * Every media rule, in id order.
 *
 * The ids start at 1001 and are never renumbered: a rule removed from this list
 * leaves its id retired (Chrome keeps dynamic rules across restarts, and a
 * reused id would apply the new host to a request the old rule was scoped for).
 */
export const MEDIA_HEADER_RULES: readonly MediaHeaderRule[] = [
  {
    id: 1001,
    note: '微博 sinaimg 防盗链：Referer 改为 weibo.com',
    urlFilter: '*sinaimg.cn*',
    headers: { Referer: 'https://weibo.com/' },
  },
  {
    id: 1002,
    note: 'Pixiv pximg 防盗链：Referer 改为 pixiv.net',
    urlFilter: '*pximg.net*',
    headers: { Referer: 'https://www.pixiv.net/' },
  },
  {
    id: 1003,
    note: 'sinaimg 的 http 升级为 https（仪表盘混合内容）',
    urlFilter: 'http://*.sinaimg.cn/*',
    headers: {},
    upgradeScheme: true,
  },
  {
    id: 1004,
    note: '小红书 xhscdn.com 防盗链：Referer + Origin',
    urlFilter: '*xhscdn.com*',
    headers: { Referer: 'https://www.xiaohongshu.com/', Origin: 'https://www.xiaohongshu.com' },
  },
  {
    id: 1005,
    note: '小红书图床（xiaohongshu.com 子域）防盗链：Referer + Origin',
    urlFilter: '*xiaohongshu.com*',
    headers: { Referer: 'https://www.xiaohongshu.com/', Origin: 'https://www.xiaohongshu.com' },
  },
  {
    id: 1006,
    note: '小红书 xhscdn.net 防盗链：Referer + Origin',
    urlFilter: '*xhscdn.net*',
    headers: { Referer: 'https://www.xiaohongshu.com/', Origin: 'https://www.xiaohongshu.com' },
  },
];

/** The ids to remove before adding, derived so the two can never disagree. */
export function ruleIds(): number[] {
  return MEDIA_HEADER_RULES.map((rule) => rule.id);
}

/** Build the Chrome rule objects for `extensionId`, scoping every one to it. */
export function buildRules(extensionId: string): chrome.declarativeNetRequest.Rule[] {
  return MEDIA_HEADER_RULES.map((rule) => {
    const action = rule.upgradeScheme
      ? { type: 'upgradeScheme' as unknown as chrome.declarativeNetRequest.RuleActionType }
      : {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: Object.entries(rule.headers).map(([header, value]) => ({
            header,
            operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
            value,
          })),
        };

    return {
      id: rule.id,
      priority: 1,
      action,
      condition: {
        urlFilter: rule.urlFilter,
        // THE scoping property: without it these rules apply to every tab the
        // user visits, not just our own requests. Asserted per rule in
        // `tests/declarativeNetRequest.test.ts`.
        initiatorDomains: [extensionId],
        resourceTypes: MEDIA_RESOURCE_TYPES as unknown as chrome.declarativeNetRequest.ResourceType[],
      },
    };
  });
}

export async function setupDeclarativeNetRules() {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: ruleIds(),
      addRules: buildRules(chrome.runtime.id),
    });
    console.log('[Chorus] declarativeNetRequest rules initialized');
  } catch (e) {
    console.warn('[Chorus] Failed to set declarativeNetRequest rules:', e);
  }
}
