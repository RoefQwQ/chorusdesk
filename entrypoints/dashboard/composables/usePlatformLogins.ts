import { ref } from 'vue';

const RPLAY_TOKEN_KEY = 'rplay_auth_token';

interface PlatformAuthCheck {
  key: string;
  domain: string;
  authCookieNames: string[];
}

const PLATFORMS_TO_CHECK: PlatformAuthCheck[] = [
  { key: 'bilibili', domain: 'bilibili.com', authCookieNames: ['DedeUserID', 'SESSDATA', 'bili_jct'] },
  { key: 'twitter', domain: 'x.com', authCookieNames: ['auth_token', 'ct0'] },
  { key: 'pixiv', domain: 'pixiv.net', authCookieNames: ['PHPSESSID'] },
  { key: 'fantia', domain: 'fantia.jp', authCookieNames: ['_session_id'] },
  { key: 'rplay', domain: 'rplay.live', authCookieNames: ['connect.sid', 'token', 'accessToken', 'refreshToken'] },
  { key: 'withny', domain: 'withny.fun', authCookieNames: ['withny_session', 'token', 'remember_web'] },
  { key: 'xiaohongshu', domain: 'xiaohongshu.com', authCookieNames: ['web_session', 'a1', 'webId'] },
  { key: 'weibo', domain: 'weibo.com', authCookieNames: ['SUB', 'SUBP', '_T_WM'] },
];

/**
 * Dashboard 设置页“平台登录状态”指示灯：经 chrome.cookies 探测各平台认证
 * Cookie，并管理 Rplay 登录凭证（chrome.storage.local + SYNC_RPLAY_TOKEN）。
 * Chrome 能力以全局 chrome 运行时探测（设置页亦可在普通浏览器标签中打开）。
 */
export function usePlatformLogins() {
  const platformLoginStatus = ref<Record<string, boolean>>({});
  const currentRplayToken = ref<string>('');

  /** 读取已存的 Rplay Token（若存在）。 */
  async function loadRplayToken(): Promise<void> {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(RPLAY_TOKEN_KEY);
      const token = stored?.[RPLAY_TOKEN_KEY];
      if (typeof token === 'string' && token) {
        currentRplayToken.value = token;
      }
    }
  }

  // Check platform cookies using chrome.cookies API accurately
  async function checkPlatformLogins() {
    if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return;

    // YouTube official RSS is publicly accessible without login
    platformLoginStatus.value['youtube'] = true;

    for (const p of PLATFORMS_TO_CHECK) {
      if (p.key === 'twitter') {
        try {
          const xCookies = await chrome.cookies.getAll({ domain: 'x.com' });
          const twCookies = await chrome.cookies.getAll({ domain: 'twitter.com' });
          const allCookies = [...xCookies, ...twCookies];
          let hasAuth = allCookies.some(c => p.authCookieNames.includes(c.name));
          if (!hasAuth && chrome.tabs) {
            const tabs = await chrome.tabs.query({ url: ['*://*.x.com/*', '*://*.twitter.com/*'] });
            if (tabs.length > 0) hasAuth = true;
          }
          platformLoginStatus.value['twitter'] = hasAuth;
        } catch {
          platformLoginStatus.value['twitter'] = false;
        }
        continue;
      }

      if (p.key === 'rplay') {
        try {
          let hasAuth = false;
          if (chrome.storage?.local) {
            const stored = await chrome.storage.local.get(RPLAY_TOKEN_KEY);
            const token = stored?.[RPLAY_TOKEN_KEY];
            if (typeof token === 'string' && token) {
              hasAuth = true;
              currentRplayToken.value = token;
            }
          }
          platformLoginStatus.value['rplay'] = hasAuth;
        } catch {
          platformLoginStatus.value['rplay'] = false;
        }
        continue;
      }

      try {
        const cookies = await chrome.cookies.getAll({ domain: p.domain });
        const hasAuth = cookies.some(c => p.authCookieNames.includes(c.name));
        platformLoginStatus.value[p.key] = hasAuth;
      } catch {
        platformLoginStatus.value[p.key] = false;
      }
    }
  }

  async function syncRplayFromTab() {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      alert('当前运行环境不支持与扩展后台通信');
      return;
    }
    try {
      const res = await chrome.runtime.sendMessage({ type: 'SYNC_RPLAY_TOKEN' });
      if (res?.success && res.token) {
        platformLoginStatus.value['rplay'] = true;
        currentRplayToken.value = res.token;
        alert('【同步成功】已从当前打开的 Rplay 页面自动提取并保存有效 Token！');
      } else {
        alert(res?.error || '未能提取到 Rplay 登录凭证。请确认浏览器中已打开 rplay.live 并且处于登录状态，或者点击【手动粘贴】进行设置。');
      }
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      alert('同步凭证请求异常: ' + message);
    }
  }

  async function promptManualRplayToken() {
    const current = currentRplayToken.value || '';
    const input = prompt(
      '【设置 / 粘贴 Rplay 登录凭证】\n请输入或粘贴 rplay.live 的 _AUTHORIZATION_ Token（如留空则清除当前保存的凭证）：',
      current
    );
    if (input === null) return;
    const token = input.trim();
    if (token) {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.set({ [RPLAY_TOKEN_KEY]: token });
      }
      platformLoginStatus.value['rplay'] = true;
      currentRplayToken.value = token;
      alert('已成功保存 Rplay Token 凭证！');
    } else {
      if (typeof chrome !== 'undefined' && chrome.storage?.local) {
        await chrome.storage.local.remove(RPLAY_TOKEN_KEY);
      }
      platformLoginStatus.value['rplay'] = false;
      currentRplayToken.value = '';
      alert('已清除保存的 Rplay Token。');
    }
  }

  return {
    platformLoginStatus,
    currentRplayToken,
    loadRplayToken,
    checkPlatformLogins,
    syncRplayFromTab,
    promptManualRplayToken,
  };
}
