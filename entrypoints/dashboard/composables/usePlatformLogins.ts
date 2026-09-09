import { ref } from 'vue';
import { checkPlatformCookieLogins } from '../../../src/infrastructure/chrome/platformAuth';

/**
 * Dashboard 设置页“平台登录状态”指示灯：委托 `platformAuth.ts` 探测各平台
 * 认证 Cookie（平台→Cookie 表只此一份）。Chrome 能力以全局 chrome 运行时
 * 探测（设置页亦可在普通浏览器标签中打开）。
 */
export function usePlatformLogins() {
  const platformLoginStatus = ref<Record<string, boolean>>({});

  /** 刷新所有平台登录状态。 */
  async function checkPlatformLogins() {
    platformLoginStatus.value = await checkPlatformCookieLogins();
  }

  return {
    platformLoginStatus,
    checkPlatformLogins,
  };
}
