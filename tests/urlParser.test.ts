import { describe, expect, it } from 'vitest';
import { parseProfileUrl, GENERATED_NAME_PREFIXES } from '../src/utils/urlParser';

/**
 * Host classification must be hostname-exact (AGENTS.md rule 1).
 *
 * `host.includes('bilibili.com')` also matches `bilibili.com.attacker.example`
 * and `https://evil.example/?ref=bilibili.com`. This parser's verdict decides
 * which platform a channel is created for — and through Douyin's collector,
 * which page the extension injects a script into — so a substring match is a
 * capability decision made on attacker-controlled text, not a cosmetic one.
 *
 * The attacker-domain cases below are the reason the 2026-09 BLOCKER existed in
 * `bgFetch`; the parser had the same shape in eight places, only Douyin had been
 * fixed, and there was no test file at all.
 */

describe('parseProfileUrl rejects attacker-controlled hosts', () => {
  const attackers = [
    'https://space.bilibili.com.attacker.example/123456',
    'https://evil.example/?ref=bilibili.com',
    'https://notbilibili.com/space/123456',
    'https://x.com.attacker.example/alice',
    'https://evil.example/?ref=x.com',
    'https://fakex.com/alice',
    'https://youtube.com.attacker.example/@alice',
    'https://pixiv.net.attacker.example/users/1',
    'https://xiaohongshu.com.attacker.example/user/profile/abc',
    'https://weibo.com.attacker.example/u/1234567890',
    'https://douyin.com.attacker.example/user/MS4wLjABAAAA',
    'https://evil.example/?ref=douyin.com',
  ];

  for (const url of attackers) {
    it(`does not classify ${url}`, () => {
      const parsed = parseProfileUrl(url);
      // It may come back as an RSS feed (a bare host is not claimed by any
      // platform) — what it must never do is claim a platform identity, which
      // would create a channel against a host we would then fetch/inject into.
      expect(parsed?.platform).not.toBe('bilibili');
      expect(parsed?.platform).not.toBe('twitter');
      expect(parsed?.platform).not.toBe('youtube');
      expect(parsed?.platform).not.toBe('pixiv');
      expect(parsed?.platform).not.toBe('xiaohongshu');
      expect(parsed?.platform).not.toBe('weibo');
      expect(parsed?.platform).not.toBe('douyin');
    });
  }
});

describe('parseProfileUrl still accepts the real hosts and their subdomains', () => {
  const cases: Array<[string, string]> = [
    ['https://space.bilibili.com/123456', 'bilibili'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'bilibili'],
    ['https://x.com/alice', 'twitter'],
    ['https://twitter.com/alice', 'twitter'],
    ['https://www.youtube.com/@alice', 'youtube'],
    ['https://www.youtube.com/channel/UCabc123', 'youtube'],
    ['https://www.pixiv.net/users/12345', 'pixiv'],
    ['https://www.fantia.jp/fanclubs/12345', 'fantia'],
    ['https://www.xiaohongshu.com/user/profile/abc123', 'xiaohongshu'],
    ['https://weibo.com/u/1234567890', 'weibo'],
    ['https://www.douyin.com/user/MS4wLjABAAAAxxxxxx', 'douyin'],
  ];

  for (const [url, platform] of cases) {
    it(`classifies ${url} as ${platform}`, () => {
      expect(parseProfileUrl(url)?.platform).toBe(platform);
    });
  }

  it('keeps self-hosted RSSHub instances classified as RSS', () => {
    // RSS is arbitrary-host by design, so this term is a usability heuristic;
    // a label test keeps `rsshub.example.com` working while dropping
    // `notreallyrsshub.example`.
    expect(parseProfileUrl('https://rsshub.example.com/bilibili/user/1')?.platform).toBe('rss');
    expect(parseProfileUrl('https://rsshub.app/bilibili/user/1')?.platform).toBe('rss');
  });
});

/**
 * The generated-prefix list must cover what the parser actually produces.
 *
 * `channelSync` used to keep its own hand-written copy of these prefixes, and
 * the two drifted twice: Withny went unnoticed for its whole lifetime, then
 * eight prefixes were found missing at once. Nothing failed either time — a
 * missing prefix silently pins a machine name forever (AGENTS rule 9/32).
 *
 * `GENERATED_NAME_PREFIXES` is now the single exported list. This test derives
 * the prefixes from the parser's real output, so adding a `suggestedName`
 * branch without listing its prefix fails here rather than in production.
 */
describe('GENERATED_NAME_PREFIXES covers every prefix the parser emits', () => {
  /** One URL per parse branch, producing a `suggestedName`. */
  const emittedNames = [
    ['https://example.com/feed.xml', 'RSS_'],
    ['https://space.bilibili.com/123456', 'B站用户_'],
    ['https://www.bilibili.com/video/BV1xx411c7mD', 'B站稿件_'],
    ['https://x.com/alice', '@'],
    ['https://www.youtube.com/@alice', ''],
    ['https://www.youtube.com/channel/UCabc123', 'Channel_'],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'YouTube视频_'],
    ['https://www.pixiv.net/users/12345', 'Pixiv画师_'],
    ['https://www.pixiv.net/artworks/999', 'Pixiv作品_'],
    ['https://www.fantia.jp/fanclubs/12345', 'Fantia俱乐部_'],
    ['https://www.fantia.jp/posts/999', 'Fantia投稿_'],
    ['https://www.xiaohongshu.com/user/profile/abc123', '小红书用户_'],
    ['https://www.xiaohongshu.com/explore/abc123', '小红书笔记_'],
    ['https://weibo.com/u/1234567890', '微博用户_'],
    ['https://weibo.com/nickname', '微博_'],
    ['https://www.douyin.com/user/MS4wLjABAAAAxxxxxx', '抖音用户_'],
    ['https://www.douyin.com/video/123456789012345', '抖音作品_'],
  ] as const;

  it('every emitted suggestedName is a listed prefix or an intentionally-unlisted handle', () => {
    for (const [url, expectedPrefix] of emittedNames) {
      const parsed = parseProfileUrl(url);
      expect(parsed, `${url} should parse`).not.toBeNull();
      const name = parsed!.suggestedName ?? '';
      if (expectedPrefix === '') {
        // YouTube's @handle branch returns the bare handle: it is the account's
        // own name, not a machine placeholder, so it is deliberately not in the
        // replacement list.
        expect(name).toBe('alice');
        continue;
      }
      expect(name.startsWith(expectedPrefix), `${url} → ${name} should start with ${expectedPrefix}`).toBe(true);
      expect(
        (GENERATED_NAME_PREFIXES as readonly string[]).includes(expectedPrefix),
        `${expectedPrefix} (from ${url}) is missing from GENERATED_NAME_PREFIXES`,
      ).toBe(true);
    }
  });

  it('lists no prefix the parser cannot produce', () => {
    const produced = new Set(emittedNames.map(([, prefix]) => prefix).filter((p) => p !== ''));
    for (const prefix of GENERATED_NAME_PREFIXES) {
      expect(
        produced.has(prefix),
        `GENERATED_NAME_PREFIXES lists ${prefix}, which no parse branch emits`,
      ).toBe(true);
    }
  });
});
