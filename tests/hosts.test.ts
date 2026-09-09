import { describe, expect, it } from 'vitest';
import {
  PLATFORM_HOSTS,
  hostMatches,
  isPlatformHost,
  parseFetchableUrl,
} from '../src/infrastructure/chrome/messages/hosts';

describe('hostMatches', () => {
  it('matches exact domain', () => {
    expect(hostMatches('pixiv.net', 'pixiv.net')).toBe(true);
  });

  it('matches subdomains but not sibling prefixes', () => {
    expect(hostMatches('www.pixiv.net', 'pixiv.net')).toBe(true);
    expect(hostMatches('api.pixiv.net', 'pixiv.net')).toBe(true);
    // The 2026-09 BLOCKER: substring matching would accept both of these.
    expect(hostMatches('pixiv.net.attacker.tld', 'pixiv.net')).toBe(false);
    expect(hostMatches('evil.example', 'pixiv.net')).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(hostMatches('WWW.Weibo.COM', 'weibo.com')).toBe(true);
  });
});

describe('isPlatformHost', () => {
  it('accepts every declared platform host', () => {
    for (const domain of PLATFORM_HOSTS) {
      expect(isPlatformHost(domain)).toBe(true);
      expect(isPlatformHost(`cdn.${domain}`)).toBe(true);
    }
  });

  it('rejects attacker-controlled look-alikes', () => {
    // Decoy query param — url.includes('pixiv.net') would have matched this.
    expect(isPlatformHost('evil.example')).toBe(false);
    expect(isPlatformHost('pixiv.net.evil.example')).toBe(false);
    expect(isPlatformHost('notpixiv.net')).toBe(false);
    expect(isPlatformHost('weibo.com.malicious.tld')).toBe(false);
    expect(isPlatformHost('rplay.live.evil.example')).toBe(false);
  });
});

describe('parseFetchableUrl', () => {
  it('parses plain http(s) URLs', () => {
    const url = parseFetchableUrl('https://www.xiaohongshu.com/user/profile/123');
    expect(url?.hostname).toBe('www.xiaohongshu.com');
  });

  it('rejects non-http(s) schemes', () => {
    expect(parseFetchableUrl('data:text/html,<script>1</script>')).toBeNull();
    expect(parseFetchableUrl('file:///etc/passwd')).toBeNull();
    expect(parseFetchableUrl('blob:https://evil.example/xyz')).toBeNull();
    expect(parseFetchableUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects embedded credentials', () => {
    expect(parseFetchableUrl('https://user:pass@weibo.com/')).toBeNull();
  });

  it('rejects garbage and non-strings', () => {
    expect(parseFetchableUrl('not a url')).toBeNull();
    expect(parseFetchableUrl('')).toBeNull();
    expect(parseFetchableUrl(null)).toBeNull();
    expect(parseFetchableUrl(12345)).toBeNull();
  });
});
