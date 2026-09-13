import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { toSecureMediaUrl } from '../src/utils/media';
import { PLATFORM_HOSTS, XHS_MEDIA_HOSTS, isXhsMediaHost } from '../src/infrastructure/chrome/messages/hosts';

/**
 * `toSecureMediaUrl` decides WHICH host an image is fetched from, so its host test
 * must be a parsed-hostname comparison (AGENTS rule 1) — never `includes(...)`.
 *
 * The substring form it replaced also matched hosts that merely *mention* the
 * domain, and the consequence was not cosmetic: the original host was replaced by
 * a platform CDN, so an image that had nothing to do with Xiaohongshu was fetched
 * from the wrong place (or not at all). Measured against the old implementation:
 *
 *   https://evil.example/avatar/xhscdn.com.jpg      → sns-avatar-qc.xhscdn.com/avatar/xhscdn.com.jpg
 *   https://xhscdn.com.attacker.tld/avatar/abc      → sns-avatar-qc.xhscdn.com/avatar/abc
 *   https://notxhscdn.com/avatar/abc                → sns-avatar-qc.xhscdn.com/avatar/abc
 *
 * These are the same look-alike shapes rule 1 names — a domain in a query string,
 * a domain as a prefix of another — so they are pinned here rather than described.
 */

describe('toSecureMediaUrl', () => {
  it('leaves a non-Xiaohongshu host alone even when its path names the domain', () => {
    // The path is attacker-feed-controlled (an RSS article may reference any URL),
    // and it must not decide the host.
    expect(toSecureMediaUrl('https://evil.example/avatar/xhscdn.com.jpg')).toBe(
      'https://evil.example/avatar/xhscdn.com.jpg',
    );
    expect(toSecureMediaUrl('https://cdn.attacker.tld/avatar/xiaohongshu.com.png')).toBe(
      'https://cdn.attacker.tld/avatar/xiaohongshu.com.png',
    );
  });

  it('leaves a host that merely ends in the domain string alone', () => {
    // `notxhscdn.com` is not `xhscdn.com`; only a dot-delimited suffix counts.
    expect(toSecureMediaUrl('https://notxhscdn.com/avatar/abc')).toBe(
      'https://notxhscdn.com/avatar/abc',
    );
    // A domain appearing as a LABEL PREFIX of an unrelated registrable domain.
    expect(toSecureMediaUrl('https://xhscdn.com.attacker.tld/avatar/abc')).toBe(
      'https://xhscdn.com.attacker.tld/avatar/abc',
    );
  });

  it('rewrites a genuine Xiaohongshu avatar to the working alias', () => {
    expect(toSecureMediaUrl('https://sns-webpic-qc.xhscdn.com/avatar/xyz')).toBe(
      'https://sns-avatar-qc.xhscdn.com/avatar/xyz',
    );
    // Already-correct hosts are unchanged.
    expect(toSecureMediaUrl('https://sns-avatar-qc.xhscdn.com/avatar/abc123')).toBe(
      'https://sns-avatar-qc.xhscdn.com/avatar/abc123',
    );
  });

  it('leaves a Xiaohongshu URL without an avatar path alone', () => {
    // The rewrite is avatar-specific; a note cover must keep its own path.
    expect(toSecureMediaUrl('https://sns-img-qc.xhscdn.com/notes/abc.jpg')).toBe(
      'https://sns-img-qc.xhscdn.com/notes/abc.jpg',
    );
  });

  it('still upgrades protocol-relative and plain-http URLs', () => {
    // The original reason this function exists: inside a chrome-extension:// page
    // a bare `//host/path` resolves against the extension scheme and 404s.
    expect(toSecureMediaUrl('//i0.hdslb.com/x.png')).toBe('https://i0.hdslb.com/x.png');
    expect(toSecureMediaUrl('http://i0.hdslb.com/x.png')).toBe('https://i0.hdslb.com/x.png');
  });

  it('returns an unparseable or empty input unchanged rather than guessing a host', () => {
    expect(toSecureMediaUrl('')).toBe('');
    expect(toSecureMediaUrl(null)).toBe('');
    expect(toSecureMediaUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    // A relative path cannot be resolved without a base, so it must not be
    // rewritten by a host test that never ran.
    expect(toSecureMediaUrl('/avatar/abc')).toBe('/avatar/abc');
    expect(toSecureMediaUrl('xhscdn.com/avatar/abc')).toBe('xhscdn.com/avatar/abc');
  });
});

describe('the Xiaohongshu media host list is declared once', () => {
  it('is a subset of the platform allowlist', () => {
    // These hosts receive the user's session in `proxyImage`, so every one of
    // them must already be an allowlisted platform host — a media host outside
    // the allowlist would be a credential leak, not a formatting bug.
    for (const domain of XHS_MEDIA_HOSTS) {
      expect(PLATFORM_HOSTS).toContain(domain);
      expect(isXhsMediaHost(domain)).toBe(true);
      expect(isXhsMediaHost(`sns-webpic-qc.${domain}`)).toBe(true);
    }
    expect(isXhsMediaHost('evil.example')).toBe(false);
    expect(isXhsMediaHost('xhscdn.com.attacker.tld')).toBe(false);
  });

  it('is not re-declared in the handler that consumes it', () => {
    // `proxyImage.ts` kept its own copy of these three domains while `media.ts`
    // hand-wrote them again — two sources for one decision is the shape rule 35
    // names. Both now import this one.
    for (const file of [
      'src/infrastructure/chrome/messages/proxyImage.ts',
      'src/utils/media.ts',
    ]) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(src, `${file} declares its own Xiaohongshu host list`).not.toMatch(
        /xhscdn\.com['"]\s*,\s*['"]xhscdn\.net/,
      );
      expect(src, `${file} should use the shared helper`).toMatch(/isXhsMediaHost/);
    }
  });
});
