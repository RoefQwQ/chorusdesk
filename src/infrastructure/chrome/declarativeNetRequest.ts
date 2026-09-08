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
 * Reapplying the same rule ids is idempotent (remove then add), so this is
 * safe to call on startup, install, or browser restart.
 *
 * @types/chrome@0.2.9 lacks `modifyHeaders` / `set` and several resourceTypes
 * literals, hence the localized casts — they stay until the types catch up.
 */
export async function setupDeclarativeNetRules() {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const rules = [
      // 1. Weibo sinaimg hotlink bypass: rewrite Referer to https://weibo.com/
      {
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://weibo.com/',
            },
          ],
        },
        condition: {
          urlFilter: '*sinaimg.cn*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
      // 2. Pixiv pximg hotlink bypass: rewrite Referer to https://www.pixiv.net/
      {
        id: 1002,
        priority: 1,
        action: {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.pixiv.net/',
            },
          ],
        },
        condition: {
          urlFilter: '*pximg.net*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
      // 3. Upgrade http to https for sinaimg (mixed-content on dashboard)
      {
        id: 1003,
        priority: 1,
        action: {
          type: 'upgradeScheme' as unknown as chrome.declarativeNetRequest.RuleActionType,
        },
        condition: {
          urlFilter: 'http://*.sinaimg.cn/*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
      // 4. Xiaohongshu xhscdn.com hotlink bypass: rewrite Referer and Origin
      {
        id: 1004,
        priority: 1,
        action: {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.com*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
      // 5. Xiaohongshu image host (xiaohongshu.com subdomains) hotlink bypass
      {
        id: 1005,
        priority: 1,
        action: {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xiaohongshu.com*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
      // 6. Xiaohongshu xhscdn.net hotlink bypass: rewrite Referer and Origin
      {
        id: 1006,
        priority: 1,
        action: {
          type: 'modifyHeaders' as unknown as chrome.declarativeNetRequest.RuleActionType,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as unknown as chrome.declarativeNetRequest.HeaderOperation,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.net*',
          initiatorDomains: [chrome.runtime.id],
          resourceTypes: [
            'image',
            'media',
            'xmlhttprequest',
          ] as unknown as chrome.declarativeNetRequest.ResourceType[],
        },
      },
    ] as unknown as chrome.declarativeNetRequest.Rule[];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006],
      addRules: rules,
    });
    console.log('[Chorus] declarativeNetRequest rules initialized');
  } catch (e) {
    console.warn('[Chorus] Failed to set declarativeNetRequest rules:', e);
  }
}
