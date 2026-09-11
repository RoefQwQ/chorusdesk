import { defineConfig } from 'wxt';
import { readFileSync } from 'node:fs';
import tailwindcss from '@tailwindcss/vite';
import { platformHostMatchPatterns } from './src/infrastructure/chrome/messages/hosts';

/**
 * The manifest version: three-part `package.json` semver, optionally with a
 * fourth component for a **store resubmission**.
 *
 * Chrome requires an uploaded version to be strictly greater than the last
 * published one, and a REJECTED upload still consumes its number — so fixing a
 * listing rejected for its wording, with no code change at all, still needs a
 * higher version. `npm version` cannot express that, and burning a PATCH for it
 * would move the product version for a reason with no meaning in the code.
 *
 * So: `package.json` stays the single source of the product version, and the
 * fourth component is supplied only when uploading to a store:
 *
 *   npm run zip                                  → 1.0.0    (identical to before)
 *   CHORUS_STORE_REVISION=3 npm run zip          → 1.0.0.3
 *
 * Version 1–4 dot-separated integers, each 0–65535, is what Chrome accepts.
 * The GitHub release is unaffected either way — same commit, same tag.
 *
 * `e2e/release-gate.mjs` asserts the manifest's first three components match
 * `package.json` (and that any fourth is a valid integer), which is the part
 * that actually protects against a stale `.output/`.
 */
function manifestVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as {
    version: string;
  };
  const raw = process.env.CHORUS_STORE_REVISION;
  if (!raw) return pkg.version;
  const revision = Number(raw);
  if (!Number.isInteger(revision) || revision < 0 || revision > 65535) {
    throw new Error(
      `CHORUS_STORE_REVISION must be an integer 0-65535 (Chrome's limit per component); got ${JSON.stringify(raw)}`,
    );
  }
  return `${pkg.version}.${revision}`;
}

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
    // Reads package.json (see `manifestVersion`), so a release is one
    // `npm version` away and the two can never disagree.
    version: manifestVersion(),
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
