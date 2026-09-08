import { ref } from 'vue';
import {
  checkPlatformCookieLogins,
  getStoredRplayToken,
  requestSyncRplayToken,
  setStoredRplayToken,
} from '../../../src/infrastructure/chrome/platformAuth';

/**
 * Dashboard 设置页“平台登录状态”指示灯：委托 `platformAuth.ts` 探测各平台
 * 认证 Cookie（平台→Cookie 表只此一份），并管理 Rplay 登录凭证
 * （chrome.storage.local + SYNC_RPLAY_TOKEN）。Chrome 能力以全局 chrome 运行时
 * 探测（设置页亦可在普通浏览器标签中打开）。
 */
export function usePlatformLogins() {
  const platformLoginStatus = ref<Record<string, boolean>>({});
  const currentRplayToken = ref<string>('');

  /** 读取已存的 Rplay Token（若存在）。 */
  async function loadRplayToken(): Promise<void> {
    currentRplayToken.value = await getStoredRplayToken();
  }

  /**
   * 刷新所有平台登录状态。返回的表中 `rplay` 仅反映已存 Token；这里额外把
   * Token 缓存进 `currentRplayToken` 供手动粘贴流程预填。
   */
  async function checkPlatformLogins() {
    const status = await checkPlatformCookieLogins();
    platformLoginStatus.value = status;
    if (status['rplay']) {
      currentRplayToken.value = await getStoredRplayToken();
    }
  }

  async function syncRplayFromTab() {
    const res = await requestSyncRplayToken();
    if (res.success && res.token) {
      platformLoginStatus.value['rplay'] = true;
      currentRplayToken.value = res.token;
      alert('【同步成功】已从当前打开的 Rplay 页面自动提取并保存有效 Token！');
    } else {
      alert(res.error || '未能提取到 Rplay 登录凭证。请确认浏览器中已打开 rplay.live 并且处于登录状态，或者点击【手动粘贴】进行设置。');
    }
  }

  async function promptManualRplayToken() {
    const current = currentRplayToken.value || '';
    const input = window.prompt(
      '【设置 / 粘贴 Rplay 登录凭证】\n请输入或粘贴 rplay.live 的 _AUTHORIZATION_ Token（如留空则清除当前保存的凭证）：',
      current
    );
    if (input === null) return;
    const token = input.trim();
    if (token) {
      await setStoredRplayToken(token);
      platformLoginStatus.value['rplay'] = true;
      currentRplayToken.value = token;
      alert('已成功保存 Rplay Token 凭证！');
    } else {
      await setStoredRplayToken('');
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
