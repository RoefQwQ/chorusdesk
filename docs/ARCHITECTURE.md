# Chorus 架构说明

> 本文档描述**当前仓库真实状态**的模块边界、依赖方向与数据流，是兼容式重构期间的施工依据。
> 文中所有路径、接口签名、表结构与常量均以当前源码为准；凡标注“迁移中/占位”的内容表示尚未完成，不得当作已落地功能使用。

## 1. 总览

- 形态：Chromium 扩展（Manifest V3），基于 [WXT](https://wxt.dev)（`wxt ^0.21.4`）+ Vue 3（`vue ^3.5.42`）+ Tailwind CSS 4 + Dexie（`dexie ^4.4.5`）。
- 定位：本地优先的多平台创作者动态聚合。无自建后端，业务数据落在浏览器 IndexedDB，设置与业务数据同库（Dexie 的 `settings` 表，键 `app_settings`）；`chrome.storage.local` 仅用于清理已卸载平台的遗留键。
- 构建入口：`entrypoints/`（WXT 约定）；产物目录 `.output/chrome-mv3/`。
- 开发/构建命令见 `package.json`：`npm run dev` / `npm run build` / `npm run zip`。
- 权限（`wxt.config.ts`，唯一来源）：`storage`、`cookies`、`activeTab`、`scripting`、`declarativeNetRequestWithHostAccess`、`alarms`；`host_permissions` 由 `PLATFORM_HOSTS` 经 `platformHostMatchPatterns()` **派生**，RSS 站点走 `optional_host_permissions`（安装时不授予任何站点）。**没有 `tabs`**（2026-09 移除）：平台标签页的 `url`/`title` 由 host 权限覆盖，Popup 当前页由 `activeTab` 覆盖（AGENTS.md 规则 7）。

当前正处于“兼容式重构”过程：职责向 `src/sync`、`src/platform`、`src/infrastructure/*` 迁移；三个迁移期兼容桶（`src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts`）**已于 2026-09-11 删除**，新代码直接依赖真实模块（见 §9.4）。**重构尚未结束**，具体边界见 §9“已知迁移边界”。

## 2. 目录结构与分层

```text
chorusdesk/
├─ entrypoints/                     # 扩展入口（薄）
│  ├─ background.ts                 # MV3 Service Worker：生命周期 + 薄消息路由
│  ├─ popup/                        # Popup 入口（App.vue + composables）
│  └─ dashboard/                    # Dashboard 入口（App.vue 组合层 + composables + views）
├─ src/
│  ├─ types/index.ts                # Platform/Creator/Channel/Post/Settings 等共享类型
│  ├─ platform/                     # Adapter 注册表（真实实现）
│  │  ├─ registry.ts                # ADAPTER_MAP + getAdapter/registerAdapter
│  ├─ adapters/                     # 各平台实现
│  │  ├─ types.ts                   # FetchOptions/FetchResult/PlatformAdapter 契约
│  │  ├─ bilibili.ts twitter.ts pixiv.ts fantia.ts
│  │  ├─ withny.ts xiaohongshu.ts weibo.ts youtube.ts rss.ts
│  │  ├─ douyin.ts                  # 抖音 adapter（快照 → Post 映射）
│  │  ├─ douyin/contract.ts         # 抖音快照校验/归一化（唯一了解页面结构的地方）
│  │  ├─ douyin/collector.ts        # 注入抖音页面的只读 DOM 采集脚本
│  ├─ sync/                         # 同步应用层（真实实现）
│  │  ├─ channelSync.ts             # 单频道同步 updateChannel / clearStaleUpdatingStatus
│  │  ├─ batchSync.ts               # 平台轮转交错批量同步
│  │  ├─ historySync.ts             # 历史翻页 fetchChannelHistory / deepSyncChannel
│  │  └─ index.ts                   # 兼容导出
│  ├─ infrastructure/
│  │  ├─ db/                        # Dexie 数据库 + 仓储（真实实现）
│  │  │  ├─ database.ts             # FeedDatabase + 版本 1-5 schema
│  │  │  ├─ settingsRepository.ts   # DEFAULT_SETTINGS / getSettings / saveSettings
│  │  │  ├─ statsService.ts         # getDatabaseStats
│  │  │  └─ postRepository.ts       # 动态生命周期：删除/回收站/清理/媒体自愈
│  │  └─ chrome/
│  │     ├─ autoSync.ts             # Alarm 自动同步 + 未读角标
│  │     ├─ declarativeNetRequest.ts# 防盗链规则 1001-1006（需 host 权限）
│  │     ├─ optionalHostAccess.ts   # RSS 源站的按站点运行时授权
│  │     └─ messages/               # 消息 handler（BG_FETCH/PROXY_IMAGE/...）
│  │        └─ hosts.ts             # PLATFORM_HOSTS：平台域名唯一来源
│  ├─ services/imageCache/          # File System Access 本地图片缓存
│  │  ├─ index.ts                   # imageCacheService 编排（含 isPostFullyCached 增量探测）
│  │  ├─ fsManager.ts               # 目录句柄持久化/权限/文件读写
│  │  └─ pathResolver.ts            # 目录分段/文件名净化/扩展名推断
│  └─ utils/                        # 无业务状态工具
│     ├─ devLog.ts                  # 开发者日志环形缓冲（chrome.storage.session）
│     ├─ http.ts                    # bgFetch（BG_FETCH 消息封装）
│     ├─ media.ts                   # toSecureMediaUrl/proxyImage/失败记忆
│     ├─ order.ts                   # 手动排序比较器与重排（sortOrder）
│     └─ urlParser.ts               # parseProfileUrl
├─ assets/main.css
├─ public/icons/
├─ wxt.config.ts
└─ README.md                        # 项目总览与基础规范（本目录为技术深化）
```

分层职责与依赖方向：

| 层 | 目录 | 规则 |
|---|---|---|
| 扩展入口 | `entrypoints/` | 只做 WXT/Chrome 注册、UI 挂载与薄路由；不承载业务流程 |
| UI 组合层 | `entrypoints/*/App.vue`、`composables/`、`components/`、`views/` | 界面状态与用户操作；不实现平台抓取/同步算法 |
| 同步应用层 | `src/sync/` | 编排单频道/批量/历史同步与保护策略；不解析平台原始响应 |
| 平台层 | `src/platform/`、`src/adapters/` | Adapter 注册、平台请求/解析、归一化 `FetchResult` |
| 数据基础设施 | `src/infrastructure/db/`（`src/db/` 兼容桶已于 2026-09-11 删除） | Dexie、仓储、数据生命周期 |
| Chrome 基础设施 | `src/infrastructure/chrome/` | 消息 handler、Alarm、角标、DNR |
| 通用工具 | `src/utils/` | URL/媒体/HTTP 辅助，无业务状态 |

依赖方向（目标态）：`entrypoints → src/sync → src/platform|src/adapters + src/infrastructure/db → src/utils`；`src/infrastructure/chrome → src/sync + src/infrastructure/db`；禁止反向依赖与环。

**当前物理依赖与目标态的差异**（Dashboard 数据/回收站组合层已完成第一阶段收敛）：
- Dashboard 与 Popup 的数据库、同步导入已直接依赖 `src/infrastructure/db/*`、`src/sync/*`；其余 UI 业务仍在 App.vue 内联。
- `src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts` 三个迁移期兼容桶已于 2026-09-11 删除（全仓 grep 为零引用后确认）；新代码直接依赖真实实现 `src/sync/*`、`src/platform/registry.ts`、`src/infrastructure/db/*`。
- `src/infrastructure/chrome/autoSync.ts` 已直接依赖 `../db/*` 与 `../../sync/channelSync`。
- 新代码（以及后续清理）应直接依赖真实实现：`src/sync/*`、`src/platform/registry.ts`、`src/infrastructure/db/*`；不要在兼容桶里新增业务逻辑。
## 2.1 本轮重构验收记录（2026-09-10 快照，其中两处结论已被 §9.4 与现状速览取代）

> 下面是当时那一轮的验收口径，保留以记录过程；`npx tsc --noEmit` 与「兼容桶保留」两条此后均已被推翻。

- 已验证：`npm run build` 成功生成 MV3 的 background、dashboard、popup 和 content script 产物。
- 已验证：类型检查通过——当时是 `npx tsc --noEmit`，现为 `npm run typecheck`（`tsc` + `vue-tsc`，后者才覆盖 `.vue`）。
- 已验证：`git diff --check` 通过；换行符提示是 Windows 工作区的 LF/CRLF 转换提示，不是内容错误。
- ~~已验证：数据库、同步、平台注册和 Runtime Message 的旧导出名称仍存在；兼容桶保留。~~ 兼容桶已于 2026-09-11 删除（§9.4）。
- 已验证：关键纯函数冒烟覆盖 URL 识别、媒体 HTTPS 规范化和平台交错同步顺序。
当前限制：尚未完成真实 Chromium 扩展的完整点击式回归。用户已明确要求不操作当前浏览器会话；后续验证必须使用独立测试浏览器配置，不得接管用户标签页。
（2026-09-11 更新：CDP `Extensions.loadUnpacked` + `--enable-unsafe-extension-debugging` 已能在独立 profile 中加载构建产物并做扩展级验证——存储、alarm、消息、真实点击与文件导入；见 AGENTS.md 规则 28 与 `PROJECT_PROGRESS_2026-09.md` 四.P7 补记。仍不可验的是跨浏览器重启后的行为。）

## 3. 扩展入口

### 3.1 `entrypoints/background.ts`（薄路由）

`defineBackground` 中按顺序完成：

1. `setupDeclarativeNetRules()`（`src/infrastructure/chrome/declarativeNetRequest.ts`）：幂等重建动态规则。
2. `setupAutoSync()`（`src/infrastructure/chrome/autoSync.ts`）：按设置重建/清除 Alarm，并刷新角标。
3. 事件注册：
   - `chrome.runtime.onInstalled` → 重复 1、2（并清理已卸载平台遗留的孤儿凭证，如已移除的 `rplay_auth_token`）；
   - `chrome.alarms.onAlarm` → `handleAutoSyncAlarm(alarm)`；
   - `chrome.runtime.onMessage` → 消息路由（§6）。

background.ts **只保留路由与生命周期注册**，消息实现全部下放到 `src/infrastructure/chrome/messages/`。

### 3.2 `entrypoints/popup/`

- `main.ts` 挂载 `App.vue`；`index.html` 固定 `width: 380px`。
- `App.vue`（单文件，未拆分）承担“快速关注”流程：识别当前页创作者 → 新建/绑定 → 首轮同步（详见 §5.1）。

### 3.3 `entrypoints/dashboard/`（页面组件已接入，组合层仍在收敛）

- `main.ts` 挂载 `App.vue`；`index.html` 含 `<meta name="referrer" content="no-referrer">`。
- `App.vue` 负责顶部导航、跨页面状态组合、全局弹窗与仍未下沉的应用动作。
- `views/FeedView.vue`、`CreatorsView.vue`、`BookmarksView.vue`、`SettingsView.vue` 均为真实页面承载组件，通过显式 context 与 emits 接收数据、上抛动作；原四个大模板区块已从 App.vue 删除。
- `CreatorsView` 已两刀下沉（2026-09-11，P4 切片 1–2）：`composables/useCreatorDirectoryFilters.ts` 持有搜索/平台/角色/标签三态筛选、排序键与方向及 `filteredCreatorsList` 等派生值（依赖以 getter 注入，保持对 props 的响应式追踪）；`components/creator/CreatorDirectoryToolbar.vue`（工具条）与 `components/creator/CreatorListView.vue`（紧凑列表）只渲染，**不持有状态**，值与动作经单一 context 契约进出；三套视图共用的 9 个动作定义在 `types/creatorDirectory.ts`（`CreatorDirectoryActions`），避免同一接口复制三遍。工具条与列表视图的根节点分别为三个 fragment 与单个 div，以保持 `<section class="space-y-4">` 的兄弟间距与原有 DOM 结构不变（逐字节渲染对比见 `e2e/creators-render.mjs`）。
- 已抽离部件：`composables/useDarkMode.ts`、`useDeletedPosts.ts`、`useDashboardData.ts`，以及 `components/PostCard.vue`、`MediaLightbox.vue`、`ImageCacheSettings.vue` 等；`composables/` 按功能分组，不在此逐一列举（列举与计数会随每次拆分失效）。
- 当前未完成：App.vue 仍直接协调部分数据库/同步、Chrome Storage、备份导入导出和全局弹窗；真实 Chromium 点击回归仍需执行。不得据此宣称入口层已完全变薄。

## 4. 核心模块边界

### 4.1 类型契约 `src/types/index.ts`

- `Platform`：`'bilibili' | 'youtube' | 'twitter' | 'pixiv' | 'fantia' | 'withny' | 'xiaohongshu' | 'weibo' | 'douyin' | 'rss' | (string & {})`。
- `PlatformMeta` + `PLATFORM_REGISTRY`：平台元数据（名称/域名/颜色/URL 占位/`authType: 'cookie' | 'localstorage' | 'none'` 与说明）。**这是 UI 展示平台名与认证类型的唯一来源**，新增平台必须在此登记。
- 实体：
  - `Creator { id, name, avatar, primaryAvatarUrl?, tags[], note?, sortOrder?, createdAt, updatedAt }`（`id` 为 uuid）。
  - `Channel { id, creatorId, platform, accountId, displayName, label?, accountRole?: 'main'|'sub'|'alt'|'custom', profileUrl, avatarUrl?, lastCheckAt?, lastSuccessAt?, status: 'idle'|'updating'|'success'|'error', errorMessage?, nextCursor? }`。`id` 形如 `"bilibili:123456"` / `"twitter:artist_sub"`。
  - `Post { id, creatorId, channelId, platform, channelLabel?, title?, content, contentHtml?, mediaList: MediaItem[], originalUrl, publishedAt, fetchedAt, isRead, isBookmarked?, isRepost?, authorMeta? }`。
    - `content` 是纯文本正文，所有平台都有，用于卡片预览、搜索与过滤。
    - `contentHtml` 是**已净化**的文章 HTML，目前仅 RSS 设置：其正文是文章而非配文，
      标题层级 / 段落 / 列表 / 行内图片就是内容本身。取值经
      `src/utils/sanitizeHtml.ts` 处理（元素与属性白名单 + 协议校验），
      渲染端（阅读视图）可直接交给 `v-html`。纯文本正文不设置该字段，
      以保留源自身的换行。
  - `AppSettings`：`theme / itemsPerFetch / requestDelayMs / enableR18Blur / autoOpenOriginalUrl / enableAutoSync? / hideReposts? / hideTextOnly? / enableImageCache? / imageCacheDirectoryName? / imageCacheStrategy? / platformOrder?`（`platformOrder` 为侧边栏平台的自定义拖拽顺序，未列出的平台按 `PLATFORM_REGISTRY` 顺序）。
  - `DeletedPostRecord { id, channelId?, creatorId?, platform?, title?, deletedAt, postData?: Post }`。

动态 `Post.id` 的生成前缀规则（分布在各自 adapter 内，**不得随意改变**，收藏/回收站/墓碑都依赖它）：

| platform | id 形态 |
|---|---|
| bilibili | `bilibili_video_<bvid>`（视频）、`bilibili_<dynId>`（动态） |
| twitter | `twitter_<tweetId>` |
| pixiv | `pixiv_<illustId>` |
| fantia | `fantia_<postId>` |
| withny | `withny_<itemId>` |
| xiaohongshu | `xiaohongshu_<noteId>` |
| weibo | `weibo_<mblogId/bid>` |
| douyin | `douyin_<awemeId>` |
| youtube | `youtube_<videoId>` |
| rss | `rss_<base64(guid) 前 32 位去特殊字符>` |

### 4.2 平台层 `src/platform/registry.ts` 与 `src/adapters/`

Adapter 契约（`src/adapters/types.ts`）：

```ts
export interface FetchOptions {
  onlyOriginal?: boolean;      // 仅原创
  cursor?: string;             // 历史翻页游标
  isHistory?: boolean;         // 深度历史挖掘
  sinceTimestamp?: number;     // 增量水位（ms）
  restoreDeleted?: boolean;    // 恢复已删动态（同步前清墓碑）
  forceRefresh?: boolean;      // 忽略水位强制刷新（重写旧动态）
}

export interface FetchResult {
  posts: Post[];
  authorMeta?: { name?: string; avatar?: string };
  nextCursor?: string;         // 下一页游标
  hasMore?: boolean;           // false 表示到底
  error?: string;              // 用户可读错误
  totalFetched?: number;       // 归一化前原始条数
}

export interface PlatformAdapter {
  platform: string;
  fetchLatest(channel: Channel, limit?: number, options?: FetchOptions): Promise<FetchResult>;
  checkAuthStatus?(): Promise<{ loggedIn: boolean; username?: string }>;
  fetchHistory?(channel, uid, limit, options, authorName?, authorAvatar?): Promise<FetchResult>;
  fetchAjaxFallback?(channel, limit, page, options?): Promise<FetchResult>;
  parseGraphQLResult?(channel, tweetData, userData, limit, onlyOriginal?, bottomCursor?): FetchResult;
}
```

`src/platform/registry.ts`（真实实现）：`ADAPTER_MAP` 记录 10 个平台 adapter；`getAdapter(platform)` 找不到时返回 `undefined`（channelSync 将其归类为 unsupported 错误，不静默回退）；`registerAdapter(key, adapter)` 供运行时注册。

各平台能力现状（`fetchLatest` 为必实现）：

| adapter | fetchLatest 主要数据源 | 可选能力 |
|---|---|---|
| `bilibili.ts` | `api.bilibili.com/x/polymer/web-dynamic/v1/feed/space`（动态）+ `x/v2/medialist/resource/list`（视频，权威源） | `fetchHistory`（offset 翻页）、`checkAuthStatus` |
| `twitter.ts` | 不直接发请求：`FETCH_TWITTER_TIMELINE` 消息 → background | `parseGraphQLResult`（归一化 GraphQL 响应） |
| `pixiv.ts` | `www.pixiv.net/ajax/user/{uid}/profile/all` + `ajax/user/{uid}?full=1` | — |
| `fantia.ts` | `fantia.jp/api/v1/fanclubs/{id}`（内嵌 recent posts） | — |
| `withny.ts` | `withny.fun/api/users/{username}/posts` | — |
| `xiaohongshu.ts` | 抓取 `www.xiaohongshu.com/user/profile/{userId}` 页面 HTML 解析 | `checkAuthStatus` |
| `weibo.ts` | `m.weibo.cn/api/container/getIndex`（uid + containerid 翻页） | `fetchAjaxFallback`（`weibo.com/ajax/statuses/mymblog`）、`checkAuthStatus` |
| `douyin.ts` | 不直接请求抖音：经 `FETCH_DOUYIN_SNAPSHOT` 从已打开的抖音标签页采集 DOM 快照（后台直连只会拿到反爬 JS 挑战页） | — |
| `youtube.ts` | 官方 RSS `www.youtube.com/feeds/videos.xml?channel_id=`（先尝试抓频道页解析 `channel_id`） | — |
| `rss.ts` | 任意 RSS/Atom 源，`bgFetch` 拉取后 DOMParser 解析 | — |

规则：adapter 只做“请求 + 归一化”，**不直接写 Dexie、不修改 Vue 状态**；跨域请求一律经 `src/utils/http.ts bgFetch()`（见 §5.4）。

### 4.3 同步应用层 `src/sync/`

统一入口函数（各文件实现，`src/sync/index.ts` re-export）：

- `channelSync.ts`
  - `clearStaleUpdatingStatus()`：把状态残留为 `updating` 的 channel 重置为 `idle`（启动/崩溃恢复）。
  - `updateChannel(channel, limit = 10, force = false, options?: FetchOptions): Promise<FetchResult>`：单频道同步核心（完整流程见 §5.2）。
- `batchSync.ts`
  - `interleaveChannelsByPlatform(channels)`：按平台分桶后轮转交错（`[B1,B2,T1,Y1] → [B1,T1,Y1,B2,...]`），降低同域连击。
  - `batchUpdateChannelsInterleaved(channelList, limit, options?)`：`options.minPlatformIntervalMs`（默认 800）同平台最小间隔；`onProgress(current,total,channel,result)`；`shouldStop()`；返回 `{ totalChannels, successful, newPostsCount }`。
  - `updateCreator(creatorId, limit, options?)`：刷新某 Creator 全部账号（平台间交错，账号间 600ms 间隔）。
- `historySync.ts`
  - `fetchChannelHistory(channel, limit = 10, onlyOriginal = false)`：游标已为 `'__END__'` 时直接返回“已到最底部”；否则以 `{ cursor: channel.nextCursor, isHistory: true }` 调 `updateChannel`。
  - `deepSyncChannel(channel, options)`：循环挖掘直到 `__END__`/`maxPosts`/`untilTimestamp`/连续 4 轮空结果；每轮拉 20 条、轮间 900ms 间隔；支持 `onProgress` 与 `shouldStop`；`forceResetCursor` 清空游标重挖。

关键保护常量（改动前先看 §同步保护是否受影响）：

| 常量 | 值 | 位置 |
|---|---|---|
| 单频道成功冷却 | 30 秒（`lastSuccessAt`，force/cursor 除外） | `channelSync.ts` |
| 单次请求超时 | 45 秒 | `channelSync.ts` |
| 历史到底标记 | `'__END__'`（`nextCursor`） | `channelSync.ts` / `historySync.ts` |
| 批量同平台最小间隔 | 800 ms（默认） | `batchSync.ts` |
| 批量账号间间隔（updateCreator） | 600 ms | `batchSync.ts` |
| 深挖每轮条数 / 轮间间隔 | 20 条 / 900 ms | `historySync.ts` |
| 深挖连续空轮上限 | 4 | `historySync.ts` |
| 自动同步周期 | 30 分钟（Alarm `creator-feed-auto-sync`） | `infrastructure/chrome/autoSync.ts` |
| 未读角标上限 / 颜色 | 999 / `#4f46e5` | `infrastructure/chrome/autoSync.ts` |

### 4.4 数据基础设施 `src/infrastructure/db/`

`database.ts` —— `FeedDatabase extends Dexie`，库名固定 `'CreatorFeedHubDB'`：

```ts
version(1): creators 'id, name, *tags, createdAt, sortOrder'
            channels 'id, creatorId, platform, accountId, status, lastCheckAt'
            posts    'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked'
            settings 'key'
version(2): posts 追加复合索引 '[channelId+publishedAt]'（频道查询/水位检查）
version(3): 新增 deletedPostIds 'id, channelId, creatorId, deletedAt'
version(4): 数据迁移（无 schema 变更）——posts 与 deletedPostIds.postData 的
            isRead / isBookmarked 由 boolean 改写为 0 | 1（索引不接受 boolean 键，
            旧值从未进入 index，`where('isRead')` 恒空 → 未读角标与收藏统计恒为 0）
version(5): 数据迁移（无 schema 变更）——清理存量推文正文尾部的 t.co 链接
            （见 src/infrastructure/db/database.ts 的 migrateStoredTweetLinks）
```

导出单例 `db`。表：`creators/channels/posts`（主键即业务 id）、`settings`（`{ key, value }` 行式存储）、`deletedPostIds`。

- `settingsRepository.ts`：`DEFAULT_SETTINGS`（默认 `enableAutoSync: false`、`requestDelayMs: 600`、`itemsPerFetch: 10` 等）；`getSettings()` 读 `settings` 表 `key === 'app_settings'` 并与默认值合并；`saveSettings(partial)` 先读后合并再 `put`。
- `statsService.ts`：`getDatabaseStats()` 返回各表计数与 `navigator.storage.estimate()` 用量（失败静默为 0）。
- `postRepository.ts`（动态生命周期，UI 通过它操作，不要绕过）：
  - `cleanupOldPosts(days = 60)`：删除早于 cutoff 且**未收藏**的动态（`days === 0` 清所有未收藏）。
  - `deletePostAndTombstone(post)`：从 `posts` 删除并把**完整快照**（`postData` 深拷贝）写入 `deletedPostIds`。
  - `restoreDeletedPost(id)` / `restoreDeletedPostId` / `restoreDeletedPostIds(ids)` / `restoreAllDeletedPostIds()`：快照还原回 `posts` 并清墓碑。
  - `permanentlyDeletePost(id)`：仅删墓碑、不还原。
  - `getDeletedPostCount()` / `getDeletedPostRecords()`：回收站计数/列表（按 `deletedAt` 倒序）。
  - `healBrokenPostMedia()`：把小红书（等）动态媒体 URL 经 `toSecureMediaUrl` 重写自愈，返回修复条数。

### 4.5 Chrome 基础设施 `src/infrastructure/chrome/`

- `autoSync.ts`：`setupAutoSync()` 按 `settings.enableAutoSync` 创建（30 分钟周期）/清除 Alarm `'creator-feed-auto-sync'`，随后 `updateUnreadBadge()`；`handleAutoSyncAlarm(alarm)` 校验名称后 `syncAllChannels()`（**串行**逐 channel `updateChannel(channel, itemsPerFetch, false, { onlyOriginal: hideReposts })`，无交错）；`updateUnreadBadge()` 统计 `posts.where('isRead').equals(0)`，封顶 999。
- `declarativeNetRequest.ts`：`setupDeclarativeNetRules()`，幂等（先 remove 再 add）重建 6 条动态规则：
  - `1001` sinaimg 改 Referer=`https://weibo.com/`；`1002` pximg 改 Referer=pixiv；`1003` sinaimg http→https 升级；`1004/1005/1006` 小红书 xhscdn.com / xiaohongshu.com / xhscdn.net 改 Referer+Origin。
  - 这些规则让 `<img>` 直连（不经代理）时也能绕过防盗链；代理路径见 §5.5。
- `messages/`：见 §6。

### 4.6 工具层 `src/utils/`

- `http.ts`：`HttpResponse { ok, status, statusText?, data: string, error? }`；`bgFetch(url, options)` 优先 `chrome.runtime.sendMessage({ type: 'BG_FETCH', url, options: { method, headers, credentials } })`，扩展环境失败时给出明确错误文案；**仅非扩展环境**走直连 `fetch` 兜底（用于本地冒烟）。所有跨域抓取统一走此函数。
- `media.ts`：`toSecureMediaUrl()`（补 `https:`、升级 `http:`、小红书 avatar 归一化到 `sns-avatar-qc.xhscdn.com`）；`proxyImage(url)`（`PROXY_IMAGE` 消息 → 返回 base64 data URL，带进程内 `imageProxyCache` Map 与 `pendingProxyFetches` 去重）；`isImageFailed/markImageFailed` 失败记忆。
- `urlParser.ts`：`parseProfileUrl(rawUrl): ParsedProfile | null`，`ParsedProfile { platform, accountId, cleanUrl, suggestedName?, isContentUrl? }`；支持 `feed://` 前缀、RSS 特征（`.xml/.rss/.atom`、`/feed`、rsshub、`?feed` 等）与全部平台主页形态；`chrome://` 等内部页跳过 DOM 注入由调用方判断。

### 4.7 图片缓存服务 `src/services/imageCache/`

- `index.ts`：`imageCacheService` 编排（`isReady/bindDirectory/unbindDirectory/cachePostImages/cachePosts.../getCachedImageUrl` 等，对外以该对象方法为准），内部经 `proxyImage`/直连取 Blob，命中磁盘后生成 object URL；进程内 `objectUrlMemoryCache` 与 `inFlightCacheJobs` 分别做内存去重与并发写去重。
- `fsManager.ts`：File System Access API；目录句柄持久化在**独立的** IndexedDB `'FeedHubFSCache'`（store `'handles'`，key `'root_cache_dir'`），与业务库 `CreatorFeedHubDB` 分开；提供 `promptSelectDirectory/verifyDirectoryPermission/getOrCreateNestedDirectory/getExistingNestedDirectory/saveBlobToFile/readFileAsBlob/...`。
- `pathResolver.ts`：目录结构 `[创作者名, 平台中文名, YYYYMMDD_短id]`（`resolvePostDirSegments`）；文件名/目录名跨平台净化 `sanitizePathSegment`（Windows 保留字符替换、去首尾点）；`resolveFileExtension` 由 MIME/URL 推断扩展名。
- 目录选择须由用户手势触发（浏览器权限要求）；绑定目录信息记录在 `settings.imageCacheDirectoryName` 与句柄库中。

## 5. 核心数据流

### 5.1 添加创作者（Popup）

```text
当前创作者页
 → popup tabs.query 取活动 tab
 → chrome.scripting.executeScript 注入 DOM 探测（昵称/头像/平台特征）
   （chrome://、edge://、about:、devtools: 内部页直接跳过）
 → parseProfileUrl(currentUrl) 识别 platform/accountId/cleanUrl
 → 用户选择：新建 Creator（db.creators.add）或绑定已有 Creator
 → db.channels.put({ id: `${platform}:${accountId}`, ... })（幂等覆盖）
 → updateChannel(newChannel, 5) 触发首次同步（fire-and-forget）
 → “打开 Dashboard”用 chrome.tabs.create({ url: getURL('/dashboard.html') })
```

### 5.2 单频道同步 `updateChannel`（手动/自动/历史共用内核）

```text
getAdapter(channel.platform)（缺失回退 rss）
 → 冷却：!force && !cursor && lastSuccessAt 距今 < 30s → 直接返回空
 → db.channels.update(id, { status: 'updating', errorMessage: undefined })
 → 水位：普通同步（无 cursor/isHistory/restoreDeleted/forceRefresh）时
   取该频道 posts 中 publishedAt 最大者作为 sinceTimestamp（复合索引 [channelId+publishedAt]）
 → mergedOptions = { ...options, sinceTimestamp }
 → Promise.race([adapter.fetchLatest(...), 45s 超时])
 ├─ result.error 且无 post → channel 置 error + 友好文案（429 → 限流提示），返回
 └─ 有 posts → 落库前过滤：
     1) forceRefresh：全部 upsert（自愈媒体）
     2) isHistory/cursor：已有 id 静默 upsert 自愈，只新增新 id（primaryKeys 判断，避免全量载入）
     3) 普通增量（sinceTimestamp>0）：丢弃 publishedAt <= 水位的
     4) 墓碑：默认过滤 deletedPostIds；restoreDeleted 时 bulkDelete 对应墓碑
     → channelLabel 兜底补全 → db.posts.bulkPut
     → bilibili 专属去重：删除与新建 bilibili_video_<bvid> 同 originalUrl 的旧 bilibili_<dynId>
 → channel 元数据：status:'success'、lastCheckAt/lastSuccessAt、errorMessage 清空
   nextCursor 三态策略：
     - 历史挖掘（isHistory 或 cursor）：有 nextCursor 就推进；hasMore===false 置 '__END__'
     - forceRefresh：nextCursor 跟随当次返回
     - 普通同步：仅当频道尚无游标时才写入（绝不覆盖已推进的历史游标）
   displayName 占位名（Channel_/B站/小红书/…前缀）被 authorMeta.name 替换；avatarUrl 每次更新
 → Creator 传播：头像为空/失效/http:// 时用 authorMeta.avatar；默认名（新创作者/未命名创作者/平台前缀）被真实名替换
 → 返回 { ...result, posts: 新增动态, totalFetched }
 catch → channel 置 error + 友好文案
 finally → 保险：若仍为 'updating' 重置为 'idle'（绝不残留转圈）
```

### 5.3 批量/自动/历史同步

- Dashboard“全部刷新”：`batchUpdateChannelsInterleaved(channels, itemsPerFetch, { onlyOriginal: hideReposts, minPlatformIntervalMs, onProgress, shouldStop })`。
- 自动同步：Alarm 每 30 分钟触发 `handleAutoSyncAlarm` → 设置关闭则清 Alarm，开启则 `syncAllChannels()`（串行）→ 刷角标。Dashboard 设置开关即时 `saveSettings` + `UPDATE_AUTO_SYNC` 消息让 background 重建 Alarm。
- 深挖历史：Dashboard 弹窗对选中 channel 调 `deepSyncChannel`/`fetchChannelHistory`（可中止 `shouldStop`），进度经 `onProgress` 展示。

### 5.4 跨域请求

```text
adapter → src/utils/http.ts bgFetch(url, options)
 → runtime.sendMessage({ type: 'BG_FETCH', url, options })
 → background 路由 → handleBgFetch(message, sendResponse)（返回 true 保持通道）
     - 非扩展环境：bgFetch 直连 fetch 兜底
     - bilibili/hdslb：仅探测 SESSDATA/DedeUserID/buvid3 是否存在并告警；
       Cookie 由 credentials:'include' + host_permissions 自动携带
       （浏览器禁止 fetch 手工设置 Cookie/UA/Referer/Origin 等受限头）
 → 响应 { ok, status, statusText, data }（失败 { ok:false, status:0, error }）
```

credentials 策略（AGENTS.md 规则 3）：仅 `PLATFORM_HOSTS` 允许名单内的域携带会话（`credentials: 'include'`），其余任意域（如用户自填的 RSS 源）一律 `credentials: 'omit'`。

### 5.5 图片加载链路

```text
渲染 <img :src="toSecureMediaUrl(...)">
 ├─ 直连成功（DNR 1001-1006 已改写防盗链头）
 └─ 403/404 等失败 → markImageFailed / proxyImage(url)
     → PROXY_IMAGE 消息 → handleProxyImage（service worker 内 fetch）
        按域注入 Referer/Origin（xiaohongshu/sinaimg-weibo/pximg/bilibili），
        候选 URL 列表依次尝试（归一化前/后、XHS 多 CDN），成功后 btoa 转 data URL
     → 图片缓存服务可把结果写盘（File System Access），后续直读磁盘 object URL
```

### 5.6 Twitter 时间线

`twitterAdapter.fetchLatest` → `FETCH_TWITTER_TIMELINE` 消息 → `handleTwitterTimeline`：
1. 页面上下文路径（主）：找已打开的 x.com/twitter.com 标签（排除登录页），无则**后台**开临时标签（`active:false`，等待 ≤4.5s）→ `scripting.executeScript` 内用页面 fetch 调 `UserByScreenName` + `UserTweets`（空指令时回退 `UserTweetsAndReplies`），提取 `bottomCursor`；临时标签用完即关。
2. 直连兜底（次）：读 `ct0` + `auth_token` Cookie，在 SW 内以公共 guest bearer token 直请求。
3. 响应 `{ success, tweetData, userData, bottomCursor }` 回到 adapter 的 `parseGraphQLResult` 归一化为 `Post[]`（含转发标记、`originalUrl = https://x.com/<u>/status/<id>`）。

## 6. Background 消息协议（当前契约）

路由在 `entrypoints/background.ts`，实现归属如下。**任何改动必须同步全部调用方并做扩展运行时验证**（详见 `docs/DEVELOPMENT.md` 第 5 节）。

| type | 发送方 | 实现位置 | 入参 | 响应 | 异步 |
|---|---|---|---|---|---|
| `UPDATE_AUTO_SYNC` | Dashboard 设置开关 | background 内联 | — | `{ success: true }` | 否 |
| `OPEN_DASHBOARD` | **当前仓库无调用方**（Popup 直接 `chrome.tabs.create` 开 `dashboard.html`）；作为契约保留 | background 内联 | — | `{ success: true }` | 否 |
| `BG_FETCH` | `src/utils/http.ts` `bgFetch()` | `messages/bgFetch.ts` `handleBgFetch` | `{ url, options: { method, headers, credentials } }` | `{ ok, status, statusText, data }`；失败 `{ ok:false, status:0, data:'', error }` | 是（返回 `true`） |
| `PROXY_IMAGE` | `src/utils/media.ts` `proxyImage()` | `messages/proxyImage.ts` `handleProxyImage` | `{ url }` | `{ ok:true, dataUrl }`；失败 `{ ok:false, error[, status] }` | 是（返回 `true`） |
| `FETCH_TWITTER_TIMELINE` | `src/adapters/twitter.ts` | `messages/twitterTimeline.ts` `handleTwitterTimeline` | `{ username, limit, onlyOriginal, cursor }` | `{ success:true, tweetData, userData, bottomCursor }`；失败 `{ success:false, error }` | 是（返回 `true`） |
| `FETCH_DOUYIN_SNAPSHOT` | `src/adapters/douyin.ts` | `messages/douyinSnapshot.ts` `handleDouyinSnapshot` | `{ secUid, limit, deep }`（`secUid` 需匹配 `^[A-Za-z0-9_-]{6,200}$`；`deep=true` 时先滚动作品网格再采集） | `{ success:true, snapshot }`；失败 `{ success:false, code, error }`，`code` 为 `auth`/`network`/`parse`/`unsupported`/`rate_limit` | 是（返回 `true`） |

各 handler 文件顶部注释均固化了自己那一半契约（入参/出参），改动协议时这些注释与 `bgFetch`/`proxyImage`/`twitterAdapter` 的调用面必须一并核对。

## 7. 存储键总览

| 存储 | 键 | 用途 | 读写方 |
|---|---|---|---|
| IndexedDB | 库 `CreatorFeedHubDB`（5 表：`creators`/`channels`/`posts`/`settings`/`deletedPostIds`） | 业务数据 | `src/infrastructure/db/*` |
| IndexedDB | 库 `FeedHubFSCache`，store `handles`，key `root_cache_dir` | 图片缓存根目录句柄 | `src/services/imageCache/fsManager.ts` |
| `chrome.storage.session` | `devLog.entries` / `devLog.verbose` | 开发者日志环形缓冲（150 条）与详细模式开关 | `src/utils/devLog.ts` |
| `localStorage`（dashboard 页） | `creator_feed_theme` | 明暗主题 | `useDarkMode.ts` |
| `localStorage`（dashboard 页） | `creator_feed_hidden_creators` / `creator_feed_hidden_platforms` | 隐藏创作者/平台偏好 | `useCreatorVisibility.ts` |
| JSON 备份 | `{ version:'1.0', exportedAt, creators, channels, settings, posts }` | 导出/导入 | `useBackupManager.ts` → `src/application/backupService.ts` + `backupFileService.ts` |

注意：当前备份格式**不含** `deletedPostIds`（回收站内容不随备份迁移），也**不含**
开发者日志（日志为会话级诊断数据，刻意排除）。

## 7.1 开发者日志

`src/utils/devLog.ts` 是所有上下文共用的日志出口：环形缓冲写入
`chrome.storage.session`，因此 Service Worker 的记录能在 worker 被回收后仍然可见，
而页面侧的订阅（`chrome.storage.onChanged`）可以实时看到后台写入。

约束（新增埋点时必须遵守）：

- **只记主机名、状态码、条数与错误消息**，不记 Cookie、Token、请求头或响应体——面板
  的用途就是被截图贴进问题反馈。
- 写入是**发后不理**（fire-and-forget）：日志失败绝不影响业务流程；`flush()` 是测试与
  「关机前落盘」的等待点。
- 缓冲上限 150 条，超出丢弃最旧；`debug` 级仅在详细模式开启时保留（判断在写入队列内完成，
  因此 `record()` 是同步的）。
- 跨上下文并发写入采用「先读后合并」，最坏情况丢一行诊断，不引入跨上下文锁。

埋点位置（scope 名即面板中的筛选值）：`sw`（worker 启动）、`router`（消息接入与拒绝）、
`alarm`（定时触发）、`bgFetch`（主机与 HTTP 状态）、`channelSync`（逐账号同步结果与错误码）、
`hostAccess`（RSS 站点授权结果）、`imageCache`（离线归档统计）。

## 8. 数据库兼容策略（原则）

1. 库名固定 `CreatorFeedHubDB`；**不得删除或重排已有 version 1–5**；schema 变更只能追加新 version，且新 version 需声明**全部** store 的完整索引（Dexie 语义）。
2. 新字段必须对旧数据有默认兜底（读取端 `getSettings` 已示范 `{ ...DEFAULT_SETTINGS, ...item.value }` 合并模式）。
3. 导入旧 JSON 必须容忍缺字段（现有导入为逐表 `bulkPut`，缺字段行保留旧行默认值）。
4. `Post.id`/`Channel.id` 生成规则不可随意改变（收藏、已读、墓碑、去重全部依赖 id）。
5. 删除动态必须走 `deletePostAndTombstone` 等仓储函数，禁止绕过墓碑裸删（否则下次同步会复活已删动态）。
6. 设置读取必须经 `getSettings()`（合并默认值），禁止假设行必然存在。

## 9. 已知迁移边界（当前真实状态）

**Dashboard 渐进拆分尚未完成，以下内容务必如实描述，勿按 README 的理想分层推断“已完成 View 重构”：**

1. Dashboard 已完成四个真实页面 View 接入：`views/FeedView.vue`、`CreatorsView.vue`、`BookmarksView.vue`、`SettingsView.vue` 均由 `App.vue` 通过 context/emits 接线；`components/DashboardSection.vue` 曾为零引用脚手架，已于 2026-09-11 删除。
2. 已抽离且正在被 App.vue 使用：`composables/useDarkMode.ts`、`composables/useDeletedPosts.ts`、`composables/useDashboardData.ts`，以及 `components/PostCard.vue`、`components/MediaLightbox.vue`、`components/ImageCacheSettings.vue`。
3. App.vue 仍保留部分跨页面应用动作、全局弹窗、Chrome Storage 与数据库协调；这属于后续入口收敛边界，不代表 View 是空壳或重复实现。
4. `src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts` 三个迁移期兼容桶**已于 2026-09-11 删除**（删除前全仓 grep 确认零引用，非类型引用亦无）；新代码直接依赖真实模块。
5. 消息 `OPEN_DASHBOARD` 保留 handler 但仓库内无发送方（Popup 直接开标签页）；删除/改造需先决定是否统一走消息。
6. `Popup/App.vue` 仍为单体（composables 已抽离 `usePageDetection`/`useQuickFollow`/`usePopupNavigation`）；Popup 尚无 `views/` 拆分计划落地。
7. 自动同步为串行单频道执行（无交错/无进度回传 UI），与 Dashboard 手动“全部刷新”的交错路径是两套实现；如需统一属功能变更，不在本次文档范围内。
