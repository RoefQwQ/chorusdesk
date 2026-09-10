import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import { platformHostMatchPatterns } from './src/infrastructure/chrome/messages/hosts';

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
    description: '聚合追踪B站、Twitter、Fantia、Pixiv、YouTube等选定创作者动态，支持多平台博主归集与被动更新。',
    // `version` intentionally unset: WXT reads package.json, so a release is
    // one `npm version` away and the two can never disagree.
    permissions: [
      'storage',
      'cookies',
      'activeTab',
      'scripting',
      // WithHostAccess: header-rewrite rules apply only where we also hold host
      // permission for the request URL, which is exactly the hotlink CDNs below.
      // The broader `declarativeNetRequest` grant is not needed.
      'declarativeNetRequestWithHostAccess',
      'alarms',
    ],
    // Derived from PLATFORM_HOSTS (src/infrastructure/chrome/messages/hosts.ts),
    // the single allowlist for platform hosts. A platform added there is
    // reachable, credentialed and permitted in one edit — the two lists used to
    // drift, which is how a documented fetch path ended up impossible.
    host_permissions: platformHostMatchPatterns(),
    // RSS is the only platform with user-supplied hosts (AGENTS.md rule 3), so
    // its origins cannot be listed above. Users grant one origin at a time,
    // prompted from the refresh action; nothing is requested at install.
    optional_host_permissions: ['*://*/*'],
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
