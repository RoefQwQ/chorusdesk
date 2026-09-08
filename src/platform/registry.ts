import type { Platform } from '../types';
import type { PlatformAdapter } from '../adapters/types';
import { bilibiliAdapter } from '../adapters/bilibili';
import { youtubeAdapter } from '../adapters/youtube';
import { twitterAdapter } from '../adapters/twitter';
import { pixivAdapter } from '../adapters/pixiv';
import { fantiaAdapter } from '../adapters/fantia';
import { rplayAdapter } from '../adapters/rplay';
import { withnyAdapter } from '../adapters/withny';
import { xiaohongshuAdapter } from '../adapters/xiaohongshu';
import { weiboAdapter } from '../adapters/weibo';
import { rssAdapter } from '../adapters/rss';

const ADAPTER_MAP: Record<string, PlatformAdapter> = {
  bilibili: bilibiliAdapter,
  youtube: youtubeAdapter,
  twitter: twitterAdapter,
  pixiv: pixivAdapter,
  fantia: fantiaAdapter,
  rplay: rplayAdapter,
  withny: withnyAdapter,
  xiaohongshu: xiaohongshuAdapter,
  weibo: weiboAdapter,
  rss: rssAdapter,
};

export function getAdapter(platform: Platform): PlatformAdapter | undefined {
  // No silent fallback: an unknown platform must surface as an unsupported
  // error (channelSync handles a missing adapter) rather than silently
  // fetching the channel's URL as RSS.
  return ADAPTER_MAP[platform];
}

export function registerAdapter(platformKey: string, adapter: PlatformAdapter): void {
  if (!platformKey.trim()) {
    throw new Error('Adapter platform key must not be empty');
  }
  if (!adapter || typeof adapter.fetchLatest !== 'function') {
    throw new Error(`Adapter '${platformKey}' must implement fetchLatest`);
  }
  ADAPTER_MAP[platformKey] = adapter;
}
