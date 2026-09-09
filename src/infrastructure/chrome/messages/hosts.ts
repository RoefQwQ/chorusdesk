/**
 * Canonical platform host allowlist shared by every privileged background
 * message handler.
 *
 * This is the single source of truth for "is this host one of the platforms we
 * were installed to talk to". It mirrors the `host_permissions` list in
 * `wxt.config.ts` — keep the two in sync when adding a platform.
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
  'withny.fun',
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
