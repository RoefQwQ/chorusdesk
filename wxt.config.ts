import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  vite: () => ({
    plugins: [
      tailwindcss(),
    ],
  }),
  manifest: {
    name: 'Chorus - 跨平台创作者聚合展台',
    description: '聚合追踪B站、Twitter、Fantia、Pixiv、YouTube、Rplay等选定创作者动态，支持多平台博主归集与被动更新。',
    version: '1.0.0',
    permissions: [
      'storage',
      'cookies',
      'activeTab',
      'tabs',
      'scripting',
      'declarativeNetRequest',
      'alarms',
    ],
    host_permissions: [
      '*://*.bilibili.com/*',
      '*://*.hdslb.com/*',
      '*://*.youtube.com/*',
      '*://*.twitter.com/*',
      '*://*.x.com/*',
      '*://*.twimg.com/*',
      '*://*.pixiv.net/*',
      '*://*.pximg.net/*',
      '*://*.fantia.jp/*',
      '*://*.rplay.live/*',
      '*://*.withny.fun/*',
      '*://*.xiaohongshu.com/*',
      '*://*.xhslink.com/*',
      '*://*.xhscdn.com/*',
      '*://*.xhscdn.net/*',
      '*://*.weibo.com/*',
      '*://*.weibo.cn/*',
      '*://*.sinaimg.cn/*',
      '*://*.douyin.com/*',
      '*://*.douyinpic.com/*',
    ],
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
    action: {
      default_title: 'Chorus',
      default_icon: {
        '16': 'icons/icon-16.png',
        '32': 'icons/icon-32.png',
        '48': 'icons/icon-48.png',
        '128': 'icons/icon-128.png',
      },
    },
  },
});
