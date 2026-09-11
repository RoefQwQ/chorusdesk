import type { Platform } from '../types';
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

const ADAPTER_MAP: Record<string, PlatformAdapter> = {
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
  return ADAPTER_MAP[platform];
}
