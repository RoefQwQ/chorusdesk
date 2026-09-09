import type { Platform } from '../types';

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
      } else if (/^(?:www\.)?(?:bilibili|twitter|x|youtube|youtu|pixiv|fantia|withny|xiaohongshu|xhslink|weibo|douyin)\./i.test(input)) {
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
    if (
      pathname.endsWith('.xml') ||
      pathname.endsWith('.rss') ||
      pathname.endsWith('.atom') ||
      pathname.endsWith('/feed') ||
      pathname.endsWith('/rss') ||
      pathname.includes('/feed/') ||
      pathname.includes('/rss/') ||
      host.includes('rsshub') ||
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
    if (host.includes('bilibili.com')) {
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
    if (host.includes('twitter.com') || host.includes('x.com')) {
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
    if (host.includes('youtube.com') || host.includes('youtu.be')) {
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
    if (host.includes('pixiv.net')) {
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
    if (host.includes('fantia.jp')) {
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

    // 6. Withny
    if (host.includes('withny.fun')) {
      const parts = pathname.split('/').filter(Boolean);
      if (parts.length >= 2 && (parts[0] === 'users' || parts[0] === 'channels')) {
        const uid = parts[1];
        return {
          platform: 'withny',
          accountId: uid,
          cleanUrl: `https://withny.fun/users/${uid}`,
          suggestedName: `Withny_${uid}`,
        };
      }
    }


    // 9. 小红书 (Xiaohongshu)
    if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) {
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
    if (host.includes('weibo.com') || host.includes('weibo.cn')) {
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
  } catch (e) {
    return null;
  }
}

/**
 * Hostname-exact (or subdomain) match. `host.includes('douyin.com')` would also
 * accept `douyin.com.attacker.example` and `evil.example/?ref=douyin.com` — see
 * AGENTS.md rule 1. The platform decision feeds channel creation and, through it,
 * which page the extension will inject a collector into, so it must be exact.
 */
function isHostOrSubdomainOf(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const base = domain.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}
