import type { Platform } from '../types';
import { hostMatches } from '../infrastructure/chrome/messages/hosts';

/**
 * Hostname-exact (or subdomain) match, re-exported under a local name.
 *
 * `isHostOrSubdomainOf(host, 'bilibili.com')` also accepts `bilibili.com.attacker.example`
 * and `evil.example/?ref=bilibili.com` — the shape of the 2026-09 BLOCKER
 * (AGENTS.md rule 1). This decision feeds channel creation and, through it,
 * which page the extension injects a collector into, so it must be exact.
 *
 * The implementation is the shared `hostMatches` rather than a second copy:
 * a private list here is exactly how the proxy and the allowlist drifted apart
 * before (rule 2).
 */
const isHostOrSubdomainOf = hostMatches;

export interface ParsedProfile {
  platform: Platform;
  accountId: string;
  cleanUrl: string;
  suggestedName?: string;
  isContentUrl?: boolean; // If user passed a video or post link instead of profile
}

export function parseProfileUrl(rawUrl: string): ParsedProfile | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;

  try {
    let input = rawUrl.trim();
    if (input.startsWith('feed://')) {
      input = `https://${input.slice(7)}`;
    }
    // Handle @username or plain domains
    if (!input.startsWith('http://') && !input.startsWith('https://')) {
      if (input.startsWith('@')) {
        input = `https://x.com/${input.slice(1)}`;
      } else if (/^(?:www\.)?(?:bilibili|twitter|x|youtube|youtu|pixiv|fantia|xiaohongshu|xhslink|weibo|douyin)\./i.test(input)) {
        input = `https://${input}`;
      } else if (/^\d{5,12}$/.test(input)) {
        // Pure digits -> likely Bilibili UID or Pixiv UID
        input = `https://space.bilibili.com/${input}`;
      }
    }

    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    const pathname = url.pathname;

    // 0. RSS / Atom / RSSHub feeds
    //
    // The RSSHub term is a usability heuristic, not a security decision: RSS is
    // the one platform whose host is arbitrary by design (AGENTS.md rule 3 —
    // the allowlist governs credentials, never reachability), so classifying a
    // URL as RSS grants no capability a user cannot already have. It is a
    // *label* test rather than `host.includes('rsshub')` so that
    // `notreallyrsshub.example` no longer rides along, and self-hosted
    // instances (`rsshub.example.com`, `rsshub-selfhost.net`) still match.
    const rssHubHost = hostMatches(host, 'rsshub.app')
      || host.split('.').some((label) => label.startsWith('rsshub'));
    if (
      pathname.endsWith('.xml') ||
      pathname.endsWith('.rss') ||
      pathname.endsWith('.atom') ||
      pathname.endsWith('/feed') ||
      pathname.endsWith('/rss') ||
      pathname.includes('/feed/') ||
      pathname.includes('/rss/') ||
      rssHubHost ||
      url.searchParams.has('feed') ||
      url.searchParams.has('rss')
    ) {
      return {
        platform: 'rss',
        accountId: url.href,
        cleanUrl: url.href,
        suggestedName: `RSS_${host.replace(/^www\./, '')}`,
      };
    }

    // 1. Bilibili
    if (isHostOrSubdomainOf(host, 'bilibili.com')) {
      // Space UID: space.bilibili.com/123456
      const spaceMatch = pathname.match(/\/?(\d+)/);
      if (host.startsWith('space.') && spaceMatch) {
        const uid = spaceMatch[1];
        return {
          platform: 'bilibili',
          accountId: uid,
          cleanUrl: `https://space.bilibili.com/${uid}`,
          suggestedName: `B站用户_${uid}`,
        };
      }

      // Video link: bilibili.com/video/BV...
      const bvidMatch = pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/i);
      if (bvidMatch) {
        return {
          platform: 'bilibili',
          accountId: bvidMatch[1],
          cleanUrl: `https://www.bilibili.com/video/${bvidMatch[1]}`,
          suggestedName: `B站稿件_${bvidMatch[1]}`,
          isContentUrl: true,
        };
      }
    }

    // 2. Twitter / X
    if (isHostOrSubdomainOf(host, 'twitter.com') || isHostOrSubdomainOf(host, 'x.com')) {
      const parts = pathname.split('/').filter(Boolean);
      const reserved = ['home', 'explore', 'notifications', 'messages', 'search', 'settings', 'i', 'compose', 'intent'];
      if (parts.length >= 1 && !reserved.includes(parts[0].toLowerCase())) {
        const username = parts[0];
        return {
          platform: 'twitter',
          accountId: username,
          cleanUrl: `https://x.com/${username}`,
          suggestedName: `@${username}`,
        };
      }
    }

    // 3. YouTube
    if (isHostOrSubdomainOf(host, 'youtube.com') || isHostOrSubdomainOf(host, 'youtu.be')) {
      // Handle: youtube.com/@username
      if (pathname.startsWith('/@')) {
        const handle = pathname.substring(2).split('/')[0];
        return {
          platform: 'youtube',
          accountId: `@${handle}`,
          cleanUrl: `https://www.youtube.com/@${handle}`,
          suggestedName: handle,
        };
      }
      // Channel ID: youtube.com/channel/UC...
      const channelMatch = pathname.match(/\/channel\/([a-zA-Z0-9_-]+)/);
      if (channelMatch) {
        const channelId = channelMatch[1];
        return {
          platform: 'youtube',
          accountId: channelId,
          cleanUrl: `https://www.youtube.com/channel/${channelId}`,
          suggestedName: `Channel_${channelId.slice(0, 8)}`,
        };
      }
      // Watch page: youtube.com/watch?v=...
      const videoId = url.searchParams.get('v');
      if (videoId) {
        return {
          platform: 'youtube',
          accountId: videoId,
          cleanUrl: `https://www.youtube.com/watch?v=${videoId}`,
          suggestedName: `YouTube视频_${videoId}`,
          isContentUrl: true,
        };
      }
    }

    // 4. Pixiv
    if (isHostOrSubdomainOf(host, 'pixiv.net')) {
      // User: pixiv.net/users/12345
      const userMatch = pathname.match(/\/users\/(\d+)/);
      if (userMatch) {
        const uid = userMatch[1];
        return {
          platform: 'pixiv',
          accountId: uid,
          cleanUrl: `https://www.pixiv.net/users/${uid}`,
          suggestedName: `Pixiv画师_${uid}`,
        };
      }
      // Artwork: pixiv.net/artworks/12345
      const artMatch = pathname.match(/\/artworks\/(\d+)/);
      if (artMatch) {
        return {
          platform: 'pixiv',
          accountId: artMatch[1],
          cleanUrl: `https://www.pixiv.net/artworks/${artMatch[1]}`,
          suggestedName: `Pixiv作品_${artMatch[1]}`,
          isContentUrl: true,
        };
      }
    }

    // 5. Fantia
    if (isHostOrSubdomainOf(host, 'fantia.jp')) {
      const fanclubMatch = pathname.match(/\/fanclubs\/(\d+)/);
      if (fanclubMatch) {
        const clubId = fanclubMatch[1];
        return {
          platform: 'fantia',
          accountId: clubId,
          cleanUrl: `https://fantia.jp/fanclubs/${clubId}`,
          suggestedName: `Fantia俱乐部_${clubId}`,
        };
      }
      const postMatch = pathname.match(/\/posts\/(\d+)/);
      if (postMatch) {
        return {
          platform: 'fantia',
          accountId: postMatch[1],
          cleanUrl: `https://fantia.jp/posts/${postMatch[1]}`,
          suggestedName: `Fantia投稿_${postMatch[1]}`,
          isContentUrl: true,
        };
      }
    }


    // 9. 小红书 (Xiaohongshu)
    if (isHostOrSubdomainOf(host, 'xiaohongshu.com') || isHostOrSubdomainOf(host, 'xhslink.com')) {
      // Profile URL: xiaohongshu.com/user/profile/5b6...
      const profileMatch = pathname.match(/\/user\/profile\/([a-zA-Z0-9_-]+)/);
      if (profileMatch) {
        const userId = profileMatch[1];
        return {
          platform: 'xiaohongshu',
          accountId: userId,
          cleanUrl: `https://www.xiaohongshu.com/user/profile/${userId}`,
          suggestedName: `小红书用户_${userId.slice(0, 6)}`,
        };
      }

      // Explore/Note URL: xiaohongshu.com/explore/64a...
      const noteMatch = pathname.match(/\/(?:explore|discovery\/item)\/([a-zA-Z0-9_-]+)/);
      if (noteMatch) {
        const noteId = noteMatch[1];
        return {
          platform: 'xiaohongshu',
          accountId: noteId,
          cleanUrl: `https://www.xiaohongshu.com/explore/${noteId}`,
          suggestedName: `小红书笔记_${noteId.slice(0, 6)}`,
          isContentUrl: true,
        };
      }
    }

    // 10. 微博 (Weibo)
    if (isHostOrSubdomainOf(host, 'weibo.com') || isHostOrSubdomainOf(host, 'weibo.cn')) {
      // Mobile: m.weibo.cn/u/1234567890 or m.weibo.cn/profile/1234567890
      const mobileMatch = pathname.match(/\/(?:u|profile)\/(\d+)/);
      if (mobileMatch) {
        const uid = mobileMatch[1];
        return {
          platform: 'weibo',
          accountId: uid,
          cleanUrl: `https://weibo.com/u/${uid}`,
          suggestedName: `微博用户_${uid}`,
        };
      }

      // PC: weibo.com/p/1005051234567890
      const pMatch = pathname.match(/\/p\/100505(\d+)/);
      if (pMatch) {
        const uid = pMatch[1];
        return {
          platform: 'weibo',
          accountId: uid,
          cleanUrl: `https://weibo.com/u/${uid}`,
          suggestedName: `微博用户_${uid}`,
        };
      }

      // PC: weibo.com/u/1234567890
      const uMatch = pathname.match(/\/u\/(\d+)/);
      if (uMatch) {
        const uid = uMatch[1];
        return {
          platform: 'weibo',
          accountId: uid,
          cleanUrl: `https://weibo.com/u/${uid}`,
          suggestedName: `微博用户_${uid}`,
        };
      }

      // Direct numeric UID: weibo.com/1234567890
      const directMatch = pathname.match(/^\/(\d{7,12})(?:\/|$)/);
      if (directMatch) {
        const uid = directMatch[1];
        return {
          platform: 'weibo',
          accountId: uid,
          cleanUrl: `https://weibo.com/u/${uid}`,
          suggestedName: `微博用户_${uid}`,
        };
      }

      // Custom vanity name: weibo.com/nickname (exclude reserved paths)
      const parts = pathname.split('/').filter(Boolean);
      const reserved = ['home', 'tv', 'hot', 'search', 'fav', 'newcard', 'message', 'setting', 'login', 'signup', 'ajax'];
      if (parts.length >= 1 && !reserved.includes(parts[0].toLowerCase())) {
        const customName = parts[0];
        return {
          platform: 'weibo',
          accountId: customName,
          cleanUrl: `https://weibo.com/${customName}`,
          suggestedName: `微博_${customName}`,
        };
      }
    }

    // 11. 抖音 (Douyin) — public creator profiles only. Live rooms
    // (live.douyin.com) are deliberately out of scope.
    if (isHostOrSubdomainOf(host, 'douyin.com') && !isHostOrSubdomainOf(host, 'live.douyin.com')) {
      // Profile: douyin.com/user/MS4wLjABAAAA...
      const userMatch = pathname.match(/\/user\/([A-Za-z0-9_-]{6,200})/);
      if (userMatch) {
        const secUid = userMatch[1];
        return {
          platform: 'douyin',
          accountId: secUid,
          cleanUrl: `https://www.douyin.com/user/${secUid}`,
          suggestedName: `抖音用户_${secUid.slice(-6)}`,
        };
      }

      // A work URL identifies the work, not its author: the author's sec_uid is
      // not in the URL, and V1 does not guess one. Flag it so the UI can tell the
      // user to paste the creator's profile instead of silently inventing a
      // channel that cannot sync.
      const workMatch = pathname.match(/\/(?:video|note)\/(\d{15,25})/);
      if (workMatch) {
        return {
          platform: 'douyin',
          accountId: workMatch[1],
          cleanUrl: `https://www.douyin.com/video/${workMatch[1]}`,
          suggestedName: `抖音作品_${workMatch[1].slice(-6)}`,
          isContentUrl: true,
        };
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Every `suggestedName` prefix this parser generates, as one list.
 *
 * Exported so `channelSync`'s legacy-name detection can be DERIVED from it
 * rather than hand-copied. That copy is the defect this list exists to end:
 * the two lists drifted twice (Withny, then eight prefixes at once), and
 * nothing failed — a missing prefix just pinned a machine name forever
 * (audit P1-5, AGENTS rule 9/32). `tests/urlParser.test.ts` asserts this list
 * matches what the parser actually produces, so a new branch cannot be added
 * without updating it.
 *
 * `@handle` (Twitter) is listed because it IS generated; it is the one entry
 * whose replacement is a product question rather than a bug, so the sync layer
 * keeps it as a deliberate exception.
 */
export const GENERATED_NAME_PREFIXES = [
  'RSS_',
  'B站用户_',
  'B站稿件_',
  '@',
  'Channel_',
  'YouTube视频_',
  'Pixiv画师_',
  'Pixiv作品_',
  'Fantia俱乐部_',
  'Fantia投稿_',
  '小红书用户_',
  '小红书笔记_',
  '微博用户_',
  '微博_',
  '抖音用户_',
  '抖音作品_',
] as const;
