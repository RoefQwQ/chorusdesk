/**
 * declarativeNetRequest dynamic rule initialization: hotlink-bypass rules for
 * image/media hosts. Reapplying the same rule ids is idempotent (remove then
 * add), so this is safe to call on both startup and install.
 */
export async function setupDeclarativeNetRules() {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) return;
  try {
    const rules: chrome.declarativeNetRequest.Rule[] = [
      // 1. Weibo Sinaimg Hotlink Bypass: rewrite Referer to https://weibo.com/
      {
        id: 1001,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://weibo.com/',
            },
          ],
        },
        condition: {
          urlFilter: '*sinaimg.cn*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 2. Pixiv Pximg Hotlink Bypass: rewrite Referer to https://www.pixiv.net/
      {
        id: 1002,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.pixiv.net/',
            },
          ],
        },
        condition: {
          urlFilter: '*pximg.net*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 3. Upgrade http to https for sinaimg
      {
        id: 1003,
        priority: 1,
        action: {
          type: 'upgradeScheme' as any,
        },
        condition: {
          urlFilter: 'http://*.sinaimg.cn/*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 4. Xiaohongshu xhscdn.com Hotlink Bypass: rewrite Referer & Origin to https://www.xiaohongshu.com/
      {
        id: 1004,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.com*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 5. Xiaohongshu image subdomains Hotlink Bypass
      {
        id: 1005,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xiaohongshu.com*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
      // 6. Xiaohongshu xhscdn.net Hotlink Bypass
      {
        id: 1006,
        priority: 1,
        action: {
          type: 'modifyHeaders' as any,
          requestHeaders: [
            {
              header: 'Referer',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com/',
            },
            {
              header: 'Origin',
              operation: 'set' as any,
              value: 'https://www.xiaohongshu.com',
            },
          ],
        },
        condition: {
          urlFilter: '*xhscdn.net*',
          resourceTypes: ['image', 'media', 'xmlhttprequest', 'sub_frame'] as any,
        },
      },
    ];

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004, 1005, 1006],
      addRules: rules,
    });
    console.log('[Chorus] declarativeNetRequest rules initialized');
  } catch (e) {
    console.warn('[Chorus] Failed to set declarativeNetRequest rules:', e);
  }
}
