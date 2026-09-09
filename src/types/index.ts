export type Platform =
  | 'bilibili'
  | 'youtube'
  | 'twitter'
  | 'pixiv'
  | 'fantia'
  | 'withny'
  | 'xiaohongshu'
  | 'weibo'
  | 'douyin'
  | 'rss'
  | (string & {});

export interface PlatformMeta {
  key: Platform;
  name: string;
  domain: string;
  color: string;
  bgColor: string;
  badgeBg: string;
  urlPlaceholder: string;
  authType: 'cookie' | 'localstorage' | 'none';
  authTypeName: string;
  description?: string;
  isCustom?: boolean;
}

export const PLATFORM_REGISTRY: Record<string, PlatformMeta> = {
  bilibili: {
    key: 'bilibili',
    name: '哔哩哔哩',
    domain: 'bilibili.com',
    color: '#00AEEC',
    bgColor: 'bg-sky-500',
    badgeBg: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:border-sky-800',
    urlPlaceholder: 'https://space.bilibili.com/123456',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持空间动态、图文与视频投稿，自动继承当前登录的 B站 会话。',
  },
  twitter: {
    key: 'twitter',
    name: 'X (Twitter)',
    domain: 'x.com',
    color: '#1DA1F2',
    bgColor: 'bg-slate-900 dark:bg-white',
    badgeBg: 'bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-800 dark:text-slate-200 dark:border-slate-700',
    urlPlaceholder: 'https://x.com/username',
    authType: 'cookie',
    authTypeName: 'Cookie / 页面会话',
    description: '优先通过打开的推特标签页及登录 Cookie 抓取，免除官方反爬 429 限制。',
  },
  youtube: {
    key: 'youtube',
    name: 'YouTube',
    domain: 'youtube.com',
    color: '#FF0000',
    bgColor: 'bg-red-600',
    badgeBg: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800',
    urlPlaceholder: 'https://www.youtube.com/@channelname',
    authType: 'none',
    authTypeName: '免密公开订阅流',
    description: '通过 YouTube 官方视频 RSS 流秒级同步，完全免登录即可使用。',
  },
  pixiv: {
    key: 'pixiv',
    name: 'Pixiv',
    domain: 'pixiv.net',
    color: '#0096FA',
    bgColor: 'bg-blue-600',
    badgeBg: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300 dark:border-blue-800',
    urlPlaceholder: 'https://www.pixiv.net/users/123456',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持插画、漫画、动图作品归集，自带防盗链安全代理查看。',
  },
  fantia: {
    key: 'fantia',
    name: 'Fantia',
    domain: 'fantia.jp',
    color: '#E01E5A',
    bgColor: 'bg-rose-500',
    badgeBg: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800',
    urlPlaceholder: 'https://fantia.jp/fanclubs/12345',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持创作者粉丝俱乐部最新投稿，共享会员会话可看专属更新。',
  },
  withny: {
    key: 'withny',
    name: 'Withny',
    domain: 'withny.fun',
    color: '#F59E0B',
    bgColor: 'bg-amber-500',
    badgeBg: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:border-amber-800',
    urlPlaceholder: 'https://withny.fun/users/username',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持创作者文字与图片发布，继承当前浏览器登录状态。',
  },
  xiaohongshu: {
    key: 'xiaohongshu',
    name: '小红书',
    domain: 'xiaohongshu.com',
    color: '#FF2442',
    bgColor: 'bg-rose-500',
    badgeBg: 'bg-rose-50 text-rose-600 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800',
    urlPlaceholder: 'https://www.xiaohongshu.com/user/profile/5b6...',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持博主图文笔记、视频归集与高清封面展示，自动继承当前浏览器登录会话。',
  },
  weibo: {
    key: 'weibo',
    name: '微博',
    domain: 'weibo.com',
    color: '#E6162D',
    bgColor: 'bg-red-600',
    badgeBg: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300 dark:border-red-800',
    urlPlaceholder: 'https://weibo.com/u/1234567890',
    authType: 'cookie',
    authTypeName: '共享浏览器 Cookie',
    description: '支持微博博主原创动态、九宫格图文、长文与视频，自动识别转发并支持源头过滤。',
  },
  douyin: {
    key: 'douyin',
    name: '抖音',
    domain: 'douyin.com',
    color: '#FE2C55',
    bgColor: 'bg-rose-600',
    badgeBg: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/50 dark:text-rose-300 dark:border-rose-800',
    urlPlaceholder: 'https://www.douyin.com/user/MS4wLjABAAAA...',
    authType: 'none',
    authTypeName: '打开的抖音页面',
    description: '支持创作者短视频与图文作品归集。抖音作品列表只能在真实页面中加载，同步前请先在浏览器打开该创作者主页。',
  },
  rss: {
    key: 'rss',
    name: '通用 RSS / Atom',
    domain: '任意 RSS 兼容站点',
    color: '#F97316',
    bgColor: 'bg-orange-500',
    badgeBg: 'bg-orange-50 text-orange-700 border-orange-200 dark:bg-orange-950/50 dark:text-orange-300 dark:border-orange-800',
    urlPlaceholder: 'https://example.com/feed.xml 或 RSSHub 地址',
    authType: 'none',
    authTypeName: '免密公开订阅流',
    description: '开放式通用订阅支持：可接入博客、Patreon、Substack、播客或 RSSHub 等任意标准 XML 源。',
  },
};

export interface Creator {
  id: string; // uuid
  name: string; // 主展示名
  avatar: string; // 主头像
  primaryAvatarUrl?: string; // 用户选择的主头像来源
  tags: string[]; // 自定义标签，如 ['ASMR', '插画', 'VUP']
  note?: string; // 自定义备忘录
  sortOrder?: number;
  createdAt: number;
  updatedAt: number;
}

export interface Channel {
  id: string; // 唯一键，例如 "bilibili:123456" 或 "twitter:artist_sub"
  creatorId: string; // 关联到 Creator.id
  platform: Platform;
  accountId: string; // 平台内ID/用户名
  displayName: string; // 平台昵称
  label?: string; // 用户自定义账号角色标签，例如 "主账号", "日常摸鱼号", "里号/R18", "熟肉切片"
  accountRole?: 'main' | 'sub' | 'alt' | 'custom';
  profileUrl: string; // 原始主页链接
  avatarUrl?: string; // 平台专属头像
  lastCheckAt?: number;
  lastSuccessAt?: number;
  status: 'idle' | 'updating' | 'success' | 'error';
  errorMessage?: string;
  nextCursor?: string; // 历史动态翻页游标 (如 Twitter bottom_cursor / B站 offset)
}

export interface MediaItem {
  type: 'image' | 'video' | 'audio';
  previewUrl: string;
  originalUrl: string;
  duration?: number;
}

export interface Post {
  id: string; // 全局唯一ID，例如 "bilibili_12345678"
  creatorId: string;
  channelId: string;
  platform: Platform;
  channelLabel?: string; // 冗余缓存账号角色标签，便于卡片即时展示
  title?: string;
  content: string;
  mediaList: MediaItem[];
  originalUrl: string;
  publishedAt: number; // 秒级或毫秒级时间戳
  fetchedAt: number;
  // Persisted as 0|1, never boolean: both fields are indexed and IndexedDB
  // refuses booleans as index keys. Read sites use truthiness.
  isRead: 0 | 1;
  isBookmarked?: 0 | 1;
  isRepost?: boolean; // 是否为转推 / 转发动态
  authorMeta?: {
    name?: string;
    avatar?: string;
  };
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  itemsPerFetch: number;
  requestDelayMs: number;
  enableR18Blur: boolean;
  autoOpenOriginalUrl: boolean;
  enableAutoSync?: boolean; // 是否启用后台定时自动同步（默认关闭，完全依靠手动更新）
  hideReposts?: boolean; // 默认是否隐藏转发/转自动态
  hideTextOnly?: boolean; // 是否过滤纯文字博文/仅看图文多媒体
  // 本地图片离线磁盘缓存设置
  enableImageCache?: boolean; // 是否启用本地图片磁盘缓存
  imageCacheDirectoryName?: string; // 用户绑定的本地目录名称
  imageCacheStrategy?: 'all' | 'restricted_only' | 'bookmarks_only'; // all: 全平台; restricted_only: 仅限小红书/微博等有时效签名平台; bookmarks_only: 仅收藏
}

export interface DeletedPostRecord {
  id: string; // 唯一动态内联ID，如 "xiaohongshu_66d01..." 或 "bilibili_123456"
  channelId?: string;
  creatorId?: string;
  platform?: Platform;
  title?: string;
  deletedAt: number;
  postData?: Post; // 完整动态快照，用于回收站定向找回与无缝还原
}


