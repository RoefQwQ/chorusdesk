import { describe, expect, it } from 'vitest';
import {
  awemeIdFromHref,
  descriptionFromAlt,
  extractHashtags,
  isAwemeId,
  normalizeItem,
  normalizeMediaUrl,
  normalizeSnapshot,
  publishedAtFromAwemeId,
  MAX_IMAGES_PER_ITEM,
  MAX_ITEMS_PER_SNAPSHOT,
} from '../src/adapters/douyin/contract';
import { buildDouyinPosts, douyinAdapter } from '../src/adapters/douyin';
import { isDouyinTabUrl } from '../src/infrastructure/chrome/messages/douyinSnapshot';
import { parseProfileUrl } from '../src/utils/urlParser';
import { isPlatformHost } from '../src/infrastructure/chrome/messages/hosts';
import type { Channel } from '../src/types';
import {
  driftedSnapshot,
  emptySnapshot,
  imageSnapshot,
  malformedSnapshot,
  videoSnapshot,
} from './fixtures/douyin/snapshots';

const channel: Channel = {
  id: 'douyin:MS4wLjABAAAAsynthetic',
  creatorId: 'creator_douyin',
  platform: 'douyin',
  accountId: 'MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
  displayName: '示例创作者',
  status: 'idle',
  profileUrl: 'https://www.douyin.com/user/MS4wLjABAAAAsyntheticSecUidForTests000000000000000000',
};

describe('douyin URL parsing', () => {
  it('parses a creator profile URL into a douyin channel', () => {
    const parsed = parseProfileUrl(
      'https://www.douyin.com/user/MS4wLjABAAAANwkoWaOu0nkVGkNVCdSNJp2LcJXi2z4z6ZbEhAiVIDs',
    );
    expect(parsed?.platform).toBe('douyin');
    expect(parsed?.accountId).toBe('MS4wLjABAAAANwkoWaOu0nkVGkNVCdSNJp2LcJXi2z4z6ZbEhAiVIDs');
    expect(parsed?.cleanUrl).toBe(
      'https://www.douyin.com/user/MS4wLjABAAAANwkoWaOu0nkVGkNVCdSNJp2LcJXi2z4z6ZbEhAiVIDs',
    );
    expect(parsed?.isContentUrl).toBeUndefined();
  });

  it('accepts the scheme-less shorthand', () => {
    expect(parseProfileUrl('www.douyin.com/user/MS4wLjABAAAAabcdef')?.platform).toBe('douyin');
  });

  it('flags a work URL as a content URL rather than inventing a creator', () => {
    const parsed = parseProfileUrl('https://www.douyin.com/video/7679013756022962021');
    expect(parsed?.platform).toBe('douyin');
    expect(parsed?.isContentUrl).toBe(true);
  });

  it('does not claim douyin for an attacker hostname', () => {
    // Substring matching would accept both of these (AGENTS.md rule 1).
    expect(parseProfileUrl('https://douyin.com.attacker.example/user/MS4wLjABAAAAabcdef')?.platform)
      .not.toBe('douyin');
    const viaQuery = parseProfileUrl('https://evil.example/?url=douyin.com/user/MS4wLjABAAAAabcdef');
    expect(viaQuery?.platform).not.toBe('douyin');
  });

  it('returns null for an unsupported douyin path', () => {
    expect(parseProfileUrl('https://www.douyin.com/')).toBeNull();
    expect(parseProfileUrl('https://www.douyin.com/discover')).toBeNull();
  });

  it('does not treat a live room as a creator profile (out of V1 scope)', () => {
    expect(parseProfileUrl('https://live.douyin.com/123456789')?.platform).not.toBe('douyin');
  });
});

describe('douyin host allowlist', () => {
  it('covers douyin.com and its media CDN', () => {
    expect(isPlatformHost('www.douyin.com')).toBe(true);
    expect(isPlatformHost('p3-pc-sign.douyinpic.com')).toBe(true);
  });

  it('rejects lookalike hosts', () => {
    expect(isPlatformHost('douyin.com.attacker.example')).toBe(false);
    expect(isPlatformHost('notdouyin.com')).toBe(false);
  });
});

describe('isDouyinTabUrl', () => {
  it('accepts a real douyin profile tab', () => {
    expect(isDouyinTabUrl('https://www.douyin.com/user/MS4wLjABAAAAabcdef')).toBe(true);
  });

  it('rejects forged, non-http and live URLs', () => {
    expect(isDouyinTabUrl('https://douyin.com.attacker.example/user/x')).toBe(false);
    expect(isDouyinTabUrl('https://evil.example/?ref=douyin.com')).toBe(false);
    expect(isDouyinTabUrl('javascript:alert(1)')).toBe(false);
    expect(isDouyinTabUrl('file:///c:/tmp/x.html')).toBe(false);
    expect(isDouyinTabUrl('https://live.douyin.com/123')).toBe(false);
    expect(isDouyinTabUrl(undefined)).toBe(false);
    expect(isDouyinTabUrl(42)).toBe(false);
  });
});

describe('aweme id handling', () => {
  it('recognizes real work ids and rejects junk', () => {
    expect(isAwemeId('7679013756022962021')).toBe(true);
    expect(isAwemeId('123')).toBe(false);
    expect(isAwemeId('76790137560229620x1')).toBe(false);
    expect(isAwemeId(null)).toBe(false);
  });

  it('derives publish time from the snowflake id', () => {
    // Real ids: the high 32 bits are the creation time in seconds.
    expect(publishedAtFromAwemeId('7107964079427423525')).toBe(1_654_951_851_000);
    expect(new Date(publishedAtFromAwemeId('7679013756022962021')).getUTCFullYear()).toBe(2026);
  });

  it('returns 0 for ids that decode to an implausible time', () => {
    expect(publishedAtFromAwemeId('100000000000000001')).toBe(0);
    expect(publishedAtFromAwemeId('99999999999999999999999')).toBe(0);
    expect(publishedAtFromAwemeId('nope')).toBe(0);
  });

  it('extracts the id from both work URL forms', () => {
    expect(awemeIdFromHref('/video/7679013756022962021')).toBe('7679013756022962021');
    expect(awemeIdFromHref('/note/7589293158236871918')).toBe('7589293158236871918');
    expect(awemeIdFromHref('https://www.douyin.com/video/7679013756022962021?source=x')).toBe(
      '7679013756022962021',
    );
    expect(awemeIdFromHref('/video/abc')).toBe('');
    expect(awemeIdFromHref(null)).toBe('');
  });
});

describe('media URL validation', () => {
  it('keeps the signature query intact', () => {
    // Douyin covers 403 without x-expires / x-signature, so "cleaning" the query
    // would break every thumbnail.
    const signed =
      'https://p3-pc-sign.douyinpic.com/obj/a.jpeg?x-expires=2104329600&x-signature=Abc%3D';
    expect(normalizeMediaUrl(signed)).toBe(signed);
  });

  it('upgrades protocol-relative and http CDN URLs to https', () => {
    expect(normalizeMediaUrl('//p3-pc.douyinpic.com/a.jpeg')).toBe('https://p3-pc.douyinpic.com/a.jpeg');
    expect(normalizeMediaUrl('http://p3-pc.douyinpic.com/a.jpeg')).toBe('https://p3-pc.douyinpic.com/a.jpeg');
  });

  it('rejects dangerous protocols, foreign hosts and credentials', () => {
    expect(normalizeMediaUrl('javascript:alert(1)')).toBe('');
    expect(normalizeMediaUrl('data:image/png;base64,AAA')).toBe('');
    expect(normalizeMediaUrl('https://evil.example/x.jpg')).toBe('');
    expect(normalizeMediaUrl('https://douyinpic.com.attacker.example/x.jpg')).toBe('');
    expect(normalizeMediaUrl('https://user:pass@p3-pc.douyinpic.com/a.jpeg')).toBe('');
    expect(normalizeMediaUrl(`https://p3-pc.douyinpic.com/${'a'.repeat(3000)}.jpeg`)).toBe('');
    expect(normalizeMediaUrl(undefined)).toBe('');
  });
});

describe('caption handling', () => {
  it('strips the "<nickname>：" prefix the cover alt carries', () => {
    expect(descriptionFromAlt('示例创作者：今天的作品', '示例创作者')).toBe('今天的作品');
    expect(descriptionFromAlt('示例创作者:半角冒号', '示例创作者')).toBe('半角冒号');
    expect(descriptionFromAlt('没有前缀的描述', '示例创作者')).toBe('没有前缀的描述');
    expect(descriptionFromAlt('', '示例创作者')).toBe('');
  });

  it('extracts hashtags in order without duplicates', () => {
    expect(extractHashtags('作品 #摄影 #日常 #摄影')).toEqual(['摄影', '日常']);
    expect(extractHashtags('无标签')).toEqual([]);
  });
});

describe('normalizeSnapshot — video fixture', () => {
  const snapshot = normalizeSnapshot(videoSnapshot)!;

  it('accepts every valid work', () => {
    expect(snapshot.items).toHaveLength(3);
    expect(snapshot.authorName).toBe('示例创作者');
    expect(snapshot.authorAvatar).toContain('douyinpic.com');
  });

  it('sorts newest first regardless of page order', () => {
    const times = snapshot.items.map((i) => i.publishedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('stores the canonical work URL, never the signed cover', () => {
    expect(snapshot.items[0].pageUrl).toBe('https://www.douyin.com/video/7679013756022962021');
    expect(snapshot.items[0].pageUrl).not.toContain('x-signature');
  });

  it('drops the author prefix from the caption and keeps hashtags', () => {
    expect(snapshot.items[0].description.startsWith('示例创作者：')).toBe(false);
    expect(snapshot.items[0].hashtags).toContain('LibTV');
  });
});

describe('normalizeSnapshot — image fixture', () => {
  const snapshot = normalizeSnapshot(imageSnapshot)!;

  it('keeps gallery order and collapses duplicate images', () => {
    const item = snapshot.items[0];
    expect(item.type).toBe('image');
    expect(item.imageUrls).toHaveLength(3);
    expect(item.imageUrls[0]).toContain('synthetic-note-1');
    expect(item.imageUrls[1]).toContain('synthetic-note-2');
    expect(item.imageUrls[2]).toContain('synthetic-note-3');
  });

  it('uses the /note/ work URL for an image post', () => {
    expect(snapshot.items[0].pageUrl).toBe('https://www.douyin.com/note/7589293158236871918');
  });
});

describe('normalizeSnapshot — hostile and degenerate input', () => {
  it('drops unidentifiable, malformed and duplicate works', () => {
    const snapshot = normalizeSnapshot(malformedSnapshot)!;
    // Only the one valid id survives, once.
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].awemeId).toBe('7638511271638600586');
  });

  it('strips dangerous and foreign media URLs from a surviving work', () => {
    const item = normalizeSnapshot(malformedSnapshot)!.items[0];
    expect(item.coverUrl).toBe('');
    expect(item.imageUrls).toEqual([]);
  });

  it('rejects a javascript: avatar', () => {
    expect(normalizeSnapshot(malformedSnapshot)!.authorAvatar).toBe('');
  });

  it('treats an empty creator as a valid empty snapshot, not a failure', () => {
    const snapshot = normalizeSnapshot(emptySnapshot);
    expect(snapshot).not.toBeNull();
    expect(snapshot!.items).toEqual([]);
  });

  it('yields zero items when the page shape drifts', () => {
    // Renamed fields must produce an empty parse the adapter can report, never
    // partially-invented posts.
    const snapshot = normalizeSnapshot(driftedSnapshot);
    expect(snapshot!.items).toEqual([]);
  });

  it('rejects a snapshot with no creator identity', () => {
    expect(normalizeSnapshot(null)).toBeNull();
    expect(normalizeSnapshot({})).toBeNull();
    expect(normalizeSnapshot({ secUid: '   ', items: [] })).toBeNull();
    expect(normalizeSnapshot('a string')).toBeNull();
  });

  it('bounds an oversized payload', () => {
    const items = Array.from({ length: MAX_ITEMS_PER_SNAPSHOT + 50 }, (_, i) => ({
      awemeId: String(7679013756022962021n + BigInt(i * 100000)),
      type: 'video',
      href: `/video/${String(7679013756022962021n + BigInt(i * 100000))}`,
      description: 'x',
      coverUrl: '',
      imageUrls: [],
    }));
    const snapshot = normalizeSnapshot({ secUid: 'MS4wLjABAAAAx', items })!;
    expect(snapshot.items.length).toBeLessThanOrEqual(MAX_ITEMS_PER_SNAPSHOT);
  });

  it('bounds the image count of one gallery', () => {
    const imageUrls = Array.from(
      { length: MAX_IMAGES_PER_ITEM + 20 },
      (_, i) => `https://p3-pc.douyinpic.com/obj/img-${i}.jpeg`,
    );
    const item = normalizeItem({
      awemeId: '7589293158236871918',
      href: '/note/7589293158236871918',
      type: 'image',
      imageUrls,
    })!;
    expect(item.imageUrls.length).toBe(MAX_IMAGES_PER_ITEM);
  });

  it('truncates an absurdly long caption', () => {
    const item = normalizeItem({
      awemeId: '7589293158236871918',
      href: '/note/7589293158236871918',
      description: 'x'.repeat(9000),
    })!;
    expect(item.description.length).toBeLessThanOrEqual(2000);
  });
});

describe('buildDouyinPosts', () => {
  const snapshot = normalizeSnapshot(videoSnapshot)!;

  it('derives a stable Post id from the aweme id alone', () => {
    const [post] = buildDouyinPosts(channel, snapshot, 10);
    expect(post.id).toBe('douyin_7679013756022962021');
  });

  it('produces the same id when caption, cover and media URLs all change', () => {
    const first = buildDouyinPosts(channel, snapshot, 10)[0];
    const mutated = normalizeSnapshot({
      ...videoSnapshot,
      items: [
        {
          ...videoSnapshot.items[0],
          description: '示例创作者：作者后来改了标题',
          coverUrl:
            'https://p3-pc-sign.douyinpic.com/obj/rotated.jpeg?x-expires=2999999999&x-signature=Different%3D',
        },
        ...videoSnapshot.items.slice(1),
      ],
    })!;
    const second = buildDouyinPosts(channel, mutated, 10)[0];
    expect(second.id).toBe(first.id);
    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it('carries channel identity and 0|1 read flags', () => {
    const [post] = buildDouyinPosts(channel, snapshot, 10);
    expect(post).toMatchObject({
      creatorId: 'creator_douyin',
      channelId: channel.id,
      platform: 'douyin',
      isRead: 0,
    });
    expect(post.isRead).not.toBe(false as unknown);
  });

  it('points a video Post at the work page, not an expiring playback URL', () => {
    const [post] = buildDouyinPosts(channel, snapshot, 10);
    expect(post.originalUrl).toBe('https://www.douyin.com/video/7679013756022962021');
    expect(post.mediaList[0]).toMatchObject({
      type: 'video',
      originalUrl: 'https://www.douyin.com/video/7679013756022962021',
    });
    // The signed cover is fine as a preview; it must not be the click target.
    expect(post.mediaList[0].previewUrl).toContain('x-signature');
  });

  it('maps an image post to its ordered gallery', () => {
    const posts = buildDouyinPosts(channel, normalizeSnapshot(imageSnapshot)!, 10);
    expect(posts[0].mediaList).toHaveLength(3);
    expect(posts[0].mediaList.every((m) => m.type === 'image')).toBe(true);
  });

  it('filters by the watermark instead of stopping at the first old work', () => {
    // Middle work is newest-1; a "stop at first old item" implementation would
    // wrongly return nothing once an older pinned work sorted ahead.
    const since = snapshot.items[1].publishedAt;
    const posts = buildDouyinPosts(channel, snapshot, 10, { sinceTimestamp: since });
    expect(posts.map((p) => p.id)).toEqual(['douyin_7679013756022962021']);
  });

  it('returns nothing new when the watermark is current', () => {
    const since = snapshot.items[0].publishedAt;
    expect(buildDouyinPosts(channel, snapshot, 10, { sinceTimestamp: since })).toEqual([]);
  });

  it('ignores the watermark on a force refresh so old posts can heal', () => {
    const since = snapshot.items[0].publishedAt;
    const posts = buildDouyinPosts(channel, snapshot, 10, { sinceTimestamp: since, forceRefresh: true });
    expect(posts).toHaveLength(3);
  });

  it('honours the requested limit', () => {
    expect(buildDouyinPosts(channel, snapshot, 2)).toHaveLength(2);
  });

  it('titles an untitled work by its type', () => {
    const bare = normalizeSnapshot({
      secUid: 'MS4wLjABAAAAx',
      items: [{ awemeId: '7589293158236871918', href: '/note/7589293158236871918', description: '' }],
    })!;
    expect(buildDouyinPosts(channel, bare, 5)[0].title).toBe('抖音图文');
  });
});

describe('history dig — grid completeness', () => {
  // The creator page does not scroll the window: the grid sits in
  // `.route-scroll-container`, whose own scrollTop drives the lazy loader. The
  // original V1 spike scrolled the window, saw no growth, and wrongly concluded
  // Douyin had no usable pagination — hence history was declared unsupported.
  // Anonymous browsing then stops partway down (measured: 18 of a stated 29).
  it('carries the stated work total through validation', () => {
    const snapshot = normalizeSnapshot({ ...videoSnapshot, statedTotal: 29 })!;
    expect(snapshot.statedTotal).toBe(29);
    expect(snapshot.items.length).toBeLessThan(29);
  });

  it('treats an absent or abbreviated total as unknown', () => {
    // Douyin abbreviates large counts ("5.9万"); guessing an expansion would
    // drive a bogus completeness check.
    expect(normalizeSnapshot(videoSnapshot)!.statedTotal).toBe(0);
    expect(normalizeSnapshot({ ...videoSnapshot, statedTotal: '5.9万' })!.statedTotal).toBe(0);
    expect(normalizeSnapshot({ ...videoSnapshot, statedTotal: -3 })!.statedTotal).toBe(0);
    expect(normalizeSnapshot({ ...videoSnapshot, statedTotal: Number.NaN })!.statedTotal).toBe(0);
  });

  it('reports whether scrolling saturated', () => {
    expect(normalizeSnapshot({ ...videoSnapshot, saturated: true })!.saturated).toBe(true);
    expect(normalizeSnapshot(videoSnapshot)!.saturated).toBe(false);
    // Only a real boolean counts; a truthy string must not pass for saturation.
    expect(normalizeSnapshot({ ...videoSnapshot, saturated: 'yes' })!.saturated).toBe(false);
  });
});

describe('douyin adapter surface', () => {
  it('does not advertise a history implementation it cannot deliver', () => {
    // `fetchChannelHistory` routes digs back through `fetchLatest`, so a
    // `fetchHistory` override here would be dead code. The refusal is expressed
    // by `hasMore: false` on the normal path instead.
    expect(douyinAdapter.fetchHistory).toBeUndefined();
    expect(douyinAdapter.platform).toBe('douyin');
  });
});

describe('placeholder-name replacement (channelSync prefixes)', () => {
  // channelSync only overwrites a channel/creator name it recognizes as a
  // placeholder. A platform whose generated names are missing from those lists
  // keeps "抖音用户_xxxxxx" forever, so the suggested names must match.
  it('generates channel names channelSync will replace', () => {
    const parsed = parseProfileUrl('https://www.douyin.com/user/MS4wLjABAAAAabcdefghijkl')!;
    expect(parsed.suggestedName?.startsWith('抖音')).toBe(true);
    expect(parsed.suggestedName?.startsWith('抖音用户_')).toBe(true);
  });

  it('generates work-URL names channelSync will replace too', () => {
    const parsed = parseProfileUrl('https://www.douyin.com/video/7679013756022962021')!;
    expect(parsed.suggestedName?.startsWith('抖音作品_')).toBe(true);
  });
});
