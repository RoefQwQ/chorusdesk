/**
 * Canonical platform host allowlist shared by every privileged background
 * message handler.
 *
 * This is the single source of truth for "is this host one of the platforms we
 * were installed to talk to". `wxt.config.ts` **derives** `host_permissions`
 * from it (`platformHostMatchPatterns()`), so adding a platform means editing
 * this list and nothing else.
 *
 * Matching is done on a parsed `URL.hostname`, never on `url.includes(...)`:
 * substring checks match attacker-controlled hosts such as
 * `https://evil.example/?ref=rplay.live` or `https://rplay.live.attacker.tld/`.
 */

/** Registrable platform domains. A host matches a domain or any subdomain of it. */
export const PLATFORM_HOSTS = [
  'bilibili.com',
  'hdslb.com',
  'youtube.com',
  'twitter.com',
  'x.com',
  'twimg.com',
  'pixiv.net',
  'pximg.net',
  'fantia.jp',
  'xiaohongshu.com',
  'xhslink.com',
  'xhscdn.com',
  'xhscdn.net',
  'weibo.com',
  'weibo.cn',
  'sinaimg.cn',
  'douyin.com',
  // Douyin cover/avatar CDN. Added because Feed cards reference signed cover
  // URLs served from `*.douyinpic.com` (verified during the 2026-09 acquisition
  // spike: covers on p3-pc-sign.douyinpic.com, avatars on p3-pc.douyinpic.com).
  // No other Douyin/ByteDance CDN is listed — only hosts observed serving the
  // media a Post actually references belong here.
  'douyinpic.com',
] as const;

/**
 * The `host_permissions` match patterns for `PLATFORM_HOSTS`, derived rather
 * than hand-maintained. `wxt.config.ts` consumes this, so a platform added
 * above can never end up reachable at runtime but missing from the manifest
 * (or vice versa) — the failure mode that made the two lists diverge before.
 */
export function platformHostMatchPatterns(): string[] {
  return PLATFORM_HOSTS.map((domain) => `*://*.${domain}/*`);
}

/** True when `hostname` equals `domain` or is a subdomain of it. */
export function hostMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const base = domain.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

/** True when `hostname` belongs to one of the declared platform domains. */
export function isPlatformHost(hostname: string): boolean {
  return PLATFORM_HOSTS.some((domain) => hostMatches(hostname, domain));
}

/**
 * Referer each media CDN expects for hotlink-protected images, keyed by
 * platform domain. A domain absent here is still proxied, just without a
 * Referer override — those CDNs (Douyin's `douyinpic.com`, for instance) do not
 * hotlink-gate on Referer, and sending another platform's Referer would be
 * worse than sending none.
 *
 * Keys are matched with `hostMatches`, and the LONGEST matching key wins, so a
 * CDN-specific entry can refine its platform's page host.
 */
export const MEDIA_REFERER_BY_DOMAIN: Record<string, string> = {
  'bilibili.com': 'https://www.bilibili.com/',
  'hdslb.com': 'https://www.bilibili.com/',
  'weibo.com': 'https://weibo.com/',
  'weibo.cn': 'https://weibo.com/',
  'sinaimg.cn': 'https://weibo.com/',
  'pixiv.net': 'https://www.pixiv.net/',
  'pximg.net': 'https://www.pixiv.net/',
  'xiaohongshu.com': 'https://www.xiaohongshu.com/',
  'xhscdn.com': 'https://www.xiaohongshu.com/',
  'xhscdn.net': 'https://www.xiaohongshu.com/',
};

/**
 * Referer to send when the background proxy fetches an image from `hostname`,
 * or `undefined` to let the browser send none of our choosing.
 */
export function resolveMediaReferer(hostname: string): string | undefined {
  let best: string | undefined;
  let bestLength = -1;
  for (const [domain, referer] of Object.entries(MEDIA_REFERER_BY_DOMAIN)) {
    if (hostMatches(hostname, domain) && domain.length > bestLength) {
      best = referer;
      bestLength = domain.length;
    }
  }
  return best;
}

/**
 * Parse a request URL and reject anything unsuitable for a background fetch:
 * non-http(s) schemes (`data:`, `file:`, `blob:`, …) and embedded credentials
 * (`https://user:pass@host/`, which some servers echo into logs).
 *
 * Returns the parsed URL or `null` when the input is unusable.
 */
export function parseFetchableUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return parsed;
}
