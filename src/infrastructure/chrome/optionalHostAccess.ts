/**
 * Optional host access for user-supplied origins.
 *
 * Every platform the extension supports is covered by `host_permissions` (see
 * `messages/hosts.ts`). RSS is the exception by design — `src/adapters/rss.ts`
 * fetches whatever feed URL the user typed, so its hosts cannot be enumerated
 * ahead of time and must not be added to the platform allowlist (AGENTS.md
 * rule 3).
 *
 * Without host permission the service worker's `fetch` is subject to CORS, which
 * most feeds satisfy but some do not. `optional_host_permissions` in the
 * manifest lets the user grant a single origin on demand, and this module is the
 * only place that asks.
 */

import { parseFetchableUrl } from './messages/hosts';

/**
 * The narrowest match pattern covering `url`, or `null` when the URL is not
 * fetchable. Only the origin is requested — never a path — so the grant is as
 * small as the request will allow.
 */
export function originPattern(url: unknown): string | null {
  const parsed = parseFetchableUrl(url);
  if (!parsed) return null;
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

/**
 * Ask for access to every origin in `urls` that is not already granted.
 *
 * MUST be the first `chrome.*` call in a click handler: Chrome only honours
 * `permissions.request` while the user gesture is live, and it consumes that
 * gesture. Already-granted origins resolve `true` without prompting, so this is
 * safe to call unconditionally — no separate `contains` pre-check, which would
 * both cost a round trip and risk expiring the gesture.
 *
 * Returns `true` when every requested origin is granted afterwards.
 */
export async function requestHostAccess(urls: unknown[]): Promise<boolean> {
  const origins = [...new Set(urls.map(originPattern).filter((p): p is string => p !== null))];
  if (origins.length === 0) return true;
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    // Declaring `optional_host_permissions` is what makes the request legal; a
    // throw here means the manifest does not cover this pattern.
    return false;
  }
}
