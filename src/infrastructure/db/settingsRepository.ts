import type { AppSettings } from '../../types';
import { db } from './database';

// Default settings
export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  itemsPerFetch: 10,
  requestDelayMs: 600,
  enableR18Blur: true,
  autoOpenOriginalUrl: false,
  enableAutoSync: false, // 默认关闭后台自动更新，完全依靠手动更新
  hideReposts: false,
  enableImageCache: true, // 默认开启本地磁盘图片缓存（需用户在设置绑定目录）
  imageCacheStrategy: 'all', // 默认全平台缓存
};

export async function getSettings(): Promise<AppSettings> {
  const item = await db.settings.get('app_settings');
  if (!item) return DEFAULT_SETTINGS;
  const stored = item.value;
  return { ...DEFAULT_SETTINGS, ...(typeof stored === 'object' && stored !== null ? stored : {}) };
}

export async function saveSettings(settings: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await db.settings.put({ key: 'app_settings', value: updated });
  return updated;
}
