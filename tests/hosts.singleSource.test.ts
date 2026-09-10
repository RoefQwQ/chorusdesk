import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  MEDIA_REFERER_BY_DOMAIN,
  PLATFORM_HOSTS,
  isPlatformHost,
  parseFetchableUrl,
  platformHostMatchPatterns,
  resolveMediaReferer,
} from '../src/infrastructure/chrome/messages/hosts';

/**
 * Regression test for AGENTS.md rule 2: `PLATFORM_HOSTS` is the single source of
 * truth for platform hosts. Every other place that names platform hosts —
 * the manifest's `host_permissions` at build time and the image proxy's
 * allowlist at runtime — must derive from it.
 *
 * The failure this pins down: `proxyImage` kept its own regex and fell behind,
 * listing neither `douyin.com` nor `douyinpic.com`. The docs and the P0
 * verification checklist meanwhile stated Douyin covers load "through the
 * background image proxy" — a path that answered `Image host is not allowed`.
 * Nothing failed loudly; the covers simply had no fallback.
 */

describe('platform host allowlist', () => {
  it('derives one manifest match pattern per host, with no duplicates', () => {
    const patterns = platformHostMatchPatterns();
    expect(patterns).toHaveLength(PLATFORM_HOSTS.length);
    expect(new Set(patterns).size).toBe(patterns.length);
    for (const [i, domain] of PLATFORM_HOSTS.entries()) {
      expect(patterns[i]).toBe(`*://*.${domain}/*`);
    }
  });

  it('produces patterns the manifest schema accepts', () => {
    for (const pattern of platformHostMatchPatterns()) {
      // `<scheme>://<host>/<path>` with a wildcard host — the shape Chrome's
      // match-pattern grammar requires for host permissions.
      expect(pattern).toMatch(/^\*:\/\/\*\.[a-z0-9.-]+\/\*$/);
    }
  });
});

describe('media proxy policy', () => {
  it('allows every platform host the allowlist declares', () => {
    // The exact check `handleProxyImage` performs before fetching.
    for (const domain of PLATFORM_HOSTS) {
      expect(isPlatformHost(domain)).toBe(true);
      expect(isPlatformHost(`cdn.${domain}`)).toBe(true);
    }
  });

  it('resolves the Referer CDNs expect, or none at all', () => {
    expect(resolveMediaReferer('i.pximg.net')).toBe('https://www.pixiv.net/');
    expect(resolveMediaReferer('wx1.sinaimg.cn')).toBe('https://weibo.com/');
    expect(resolveMediaReferer('p3-pc-sign.douyinpic.com')).toBeUndefined();
    expect(resolveMediaReferer('i0.hdslb.com')).toBe('https://www.bilibili.com/');
  });

  it('only ever returns a Referer for a declared platform host', () => {
    for (const domain of Object.keys(MEDIA_REFERER_BY_DOMAIN)) {
      expect(PLATFORM_HOSTS).toContain(domain);
    }
    // A host outside the allowlist is never proxied, so it can never get a
    // Referer either — the two policies cannot disagree.
    expect(resolveMediaReferer('evil.example')).toBeUndefined();
  });

  it('does not match a look-alike host carrying the domain in its path', () => {
    const spoofed = parseFetchableUrl('https://evil.example/?ref=douyin.com');
    expect(spoofed).not.toBeNull();
    expect(isPlatformHost(spoofed!.hostname)).toBe(false);
    expect(resolveMediaReferer(spoofed!.hostname)).toBeUndefined();
  });
});

describe('manifest wiring', () => {
  it('builds host_permissions from the allowlist, not a second list', () => {
    const config = readFileSync(new URL('../wxt.config.ts', import.meta.url), 'utf8');
    expect(config).toContain('host_permissions: platformHostMatchPatterns()');
    // An inline pattern literal would mean a second source of truth exists.
    expect(config).not.toMatch(/\*:\/\/\*\./);
  });

  it('does not keep a private allowlist inside the image proxy', () => {
    const proxy = readFileSync(
      new URL('../src/infrastructure/chrome/messages/proxyImage.ts', import.meta.url),
      'utf8',
    );
    // The old handler matched hosts with its own alternation regex.
    expect(proxy).not.toMatch(/bilibili\\\.com\|hdslb/);
    expect(proxy).toContain('isPlatformHost(');
  });
});
