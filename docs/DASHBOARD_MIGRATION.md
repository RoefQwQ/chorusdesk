# Dashboard 重构记录

## 目标

在不改变 Dashboard 用户行为、数据库调用语义、同步参数和模板事件契约的前提下，将 `entrypoints/dashboard/App.vue` 从页面单体逐步变为页面组合层。

## 当前状态

已完成：

- `entrypoints/dashboard/composables/useDarkMode.ts`：主题状态和 `localStorage` 持久化，已在 Dashboard 入口使用。
- `entrypoints/dashboard/composables/useDeletedPosts.ts`：回收站状态、过滤、删除、恢复和同步动作，已在 Dashboard 入口使用。
- `entrypoints/dashboard/composables/useDashboardData.ts`：创作者、频道、动态、统计和媒体修复后的数据加载，已在 Dashboard 入口使用。
- Dashboard 与 Popup 的数据库/同步导入已切换到真实 `src/infrastructure/db/*`、`src/sync/*` 实现。
- `entrypoints/dashboard/components/PostCard.vue`：动态卡片。
- `entrypoints/dashboard/components/MediaLightbox.vue`：媒体预览。
- `entrypoints/dashboard/components/ImageCacheSettings.vue`：本地图片缓存设置。
已完成：Feed、Creators、Bookmarks、Settings 四个真实页面组件已接入 `App.vue`，原四个大模板区块已删除。
已完成：页面组件通过显式 `context` 数据/动作契约与 `App.vue` 组合层通信；View 不直接访问 Dexie、Adapter 或 Chrome 内部 API。
已完成：Feed 的搜索、平台筛选和灯箱事件通过 emits 回传；Creators 的管理动作通过 emits 回传；Bookmarks/Settings 通过 context actions 回传。
当前边界：App.vue 仍保留跨页面状态组合、弹窗、备份导入导出、登录检测和部分数据库动作，后续可继续下沉到 composable/application service。
迁移边界和当前已验证行为见 `docs/ARCHITECTURE.md` §2、§9。

## 迁移顺序

必须按以下顺序迁移，避免组件先失去依赖：

1. 保持 `App.vue` 中现有模板区域不变，先为每个页面建立 View 的 props/emits 契约。
2. 为 View 所需数据建立 composable，所有基础设施通过参数或应用服务注入。
3. 先迁移 Feed 的只读列表和筛选，再迁移同步动作。
4. 迁移 Creators 的新增、编辑、标签、频道角色和删除流程。
5. 迁移 Bookmarks 的筛选、已读和收藏动作。
6. 最后迁移 Settings 的同步设置、登录状态、备份、清理和图片缓存。
7. 删除 App.vue 中已迁移的状态和函数，禁止保留两套实现。

## View 约束

View 可以接收：

- 展示数据
- 过滤状态
- 加载状态
- 明确的事件回调

View 不应直接：

- 导入 Dexie 实例
- 调用平台 Adapter
- 发送 Background 内部消息
- 读取 Chrome Cookie
- 修改数据库表

## Composable 约束

Composable 负责页面状态和用户动作编排，但不应复制同步或数据库实现。优先通过依赖注入接收：

```ts
interface Dependencies {
  reloadData: () => Promise<void>;
  updateChannel: typeof updateChannel;
  repository: Repository;
}
```

跨页面共享的数据加载应复用 `useDashboardData`，不能在每个 View 中重复查询 `db.posts`。

## 验收标准

> **状态（2026-09-10）**：本节的验收清单是 Dashboard 重构期间的工作记录，其"真实运行时回归"
> 一项已由后续的真实 Chrome 使用验证（`PROJECT_PROGRESS_2026-09.md` 四.P0）与三轮逐项走查
> （同文四.P1）实际覆盖，**不再作为待办跟踪**。原文保留以记录当时的验收口径。
> 其中「App.vue 不直接执行备份导入导出」等条目在重构收口时已满足，只是本清单未回填。
> `npx tsc --noEmit` 的说明也已过时：现为 `npm run typecheck`，且**同时运行 `vue-tsc`**
> ——仅跑 `tsc` 时 `.vue` 文件一个都不会被解析。

Dashboard 重构只有在以下条件全部满足时才算最终完成；本轮已满足的条目标记为 `[x]`：

```text
[ ] App.vue 只负责布局、页面导航和跨页面状态组合（仍有跨页面业务动作）
[x] FeedView、CreatorsView、BookmarksView、SettingsView 都是真实页面承载组件
[ ] App.vue 不直接访问 Dexie
[ ] App.vue 不直接调用同步函数
[ ] App.vue 不直接读取 Chrome Cookie/Storage
[ ] App.vue 不直接执行备份导入导出
[x] 每项业务流程只有一份实现
[x] 模板事件、用户文案、数据库数据格式保持兼容
[x] npm run build 通过
[ ] Popup、Dashboard、同步、收藏、回收站、备份流程完成真实运行时回归
```

## 禁止的“伪重构”

以下情况不算完成：

- 只新增空的 View 文件。
- 只抽取主题或一个弹窗就声称 Dashboard 已分层。
- 把原来的 4000 行复制到新的 composable。
- View 直接导入 `db`，只是从 App.vue 移动到另一个大文件。
- 同时保留旧函数和新函数两套真实实现。
## 本轮增量验收

- `npm run build`：通过，成功生成 Manifest V3 的 background、dashboard、popup、content script 产物。
- `npx tsc --noEmit`：通过；项目类型环境由 `@types/chrome` 与 `types/env.d.ts` 提供。
- `git diff --check`：通过；Windows LF/CRLF 提示不属于内容错误。
- 关键纯函数冒烟：通过；YouTube URL 识别为 `youtube`、协议相对媒体 URL 正确升级为 HTTPS、平台交错顺序符合预期。
- 图片代理安全边界：通过代码审查；只允许声明平台/CDN 域名及 HTTP(S)，拒绝用户信息与未知主机。
未覆盖：真实 Chromium 扩展页面点击回归。用户明确要求不操作当前浏览器会话；后续如需验证，应使用独立测试浏览器配置加载 `.output/chrome-mv3/`，不得导航或接管用户正在使用的标签页。
## 瀑布流空白修复

- 问题：Feed 页在拆分为 `FeedView` 后，瀑布流创建的 `PostCard` 没有接收到组件契约要求的 `creators` 和 `channels` props，导致卡片无法正确解析作者与频道数据；界面只显示左右侧栏，中间区域为空白。
- 修复：将 `context.creators`、`context.channels` 显式传给每个 `PostCard`；同时为列数、分页数量增加至少一列/一条的边界保护。
- 保持：数据筛选、分页、瀑布流列分配、收藏、删除、已读、媒体预览和用户文案不变。
- 验证：`npx tsc --noEmit`、`npm run build`、`git diff --check` 通过；源码级渲染契约冒烟确认 PostCard props 与非空列保护存在。

每次页面迁移后必须逐项验证以下用户可观察行为：

> **状态（2026-09-10）**：以下 12 项已在真实 Chrome 中实际操作覆盖
> （见 `PROJECT_PROGRESS_2026-09.md` 四.P0 与四.P1；第四批又修复了其中若干项的实现缺陷），
> **本清单不再作为待办跟踪**，仅保留最初的验证口径。第四批新增的待验证项见该文四.P7。

```text
[ ] Popup 识别当前平台主页并正确显示平台、账号和头像
[ ] 新建创作者、绑定已有创作者、重复绑定提示和首轮同步
[ ] Dashboard 首次加载动态、平台筛选、关键词搜索和标签包含/排除
[ ] 转发过滤、纯文字过滤、分页/无限滚动和瀑布流布局
[ ] 单频道同步、创作者同步、全部同步、历史同步和停止深挖
[ ] 收藏、取消收藏、已读、删除墓碑、单条恢复和批量恢复
[ ] 回收站永久删除、清空、搜索和同步恢复
[ ] 创作者编辑、标签修改、隐藏创作者和平台账号管理
[ ] 设置保存、平台登录状态和自动同步开关
[ ] 图片代理、CDN 自愈、灯箱预览和本地图片缓存
[ ] JSON 导出、旧 JSON 导入、数据清理和收藏保护
[ ] Background 消息异步响应、错误提示、超时和限流提示
```

构建和类型检查只能证明模块可打包，不能替代上述运行时回归。
