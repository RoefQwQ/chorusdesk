import { isKnownPlatform, type KnownPlatform, type Platform } from '../types';
import type { PlatformAdapter } from '../adapters/types';
import { bilibiliAdapter } from '../adapters/bilibili';
import { youtubeAdapter } from '../adapters/youtube';
import { twitterAdapter } from '../adapters/twitter';
import { pixivAdapter } from '../adapters/pixiv';
import { fantiaAdapter } from '../adapters/fantia';
import { xiaohongshuAdapter } from '../adapters/xiaohongshu';
import { weiboAdapter } from '../adapters/weibo';
import { douyinAdapter } from '../adapters/douyin';
import { rssAdapter } from '../adapters/rss';

/**
 * Keyed by `KnownPlatform`, not `Platform`: `Record<Platform, …>` accepts any
 * string key and therefore cannot report a missing platform, which is how
 * "add a platform" stayed a 6–8 touch-point list with no compiler help
 * (audit P1-12). With the closed key set, a new member of `KnownPlatform` is a
 * type error here until an adapter exists for it.
 */
const ADAPTER_MAP: Record<KnownPlatform, PlatformAdapter> = {
  bilibili: bilibiliAdapter,
  youtube: youtubeAdapter,
  twitter: twitterAdapter,
  pixiv: pixivAdapter,
  fantia: fantiaAdapter,
  xiaohongshu: xiaohongshuAdapter,
  weibo: weiboAdapter,
  douyin: douyinAdapter,
  rss: rssAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter | undefined {
  // No silent fallback: an unknown platform must surface as an unsupported
  // error (channelSync handles a missing adapter) rather than silently
  // fetching the channel's URL as RSS.
  //
  // `isKnownPlatform` narrows `Platform` (which includes `(string & {})` for
  // stored legacy keys) to the closed set, so the lookup needs no `as` cast:
  // the guard IS the assertion, in code rather than in a comment. It also says
  // out loud that "unknown platform" is a handled case, not a table miss.
  if (!isKnownPlatform(platform)) return undefined;
  return ADAPTER_MAP[platform];
}
