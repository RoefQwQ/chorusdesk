# Chorus 开发手册

> 面向在本仓库做增量功能与兼容式重构的开发说明。配合 `docs/ARCHITECTURE.md` 使用；本手册只讲“怎么改”，涉及现状与边界时以 ARCHITECTURE.md 为准。
> 项目默认中文注释与中文用户文案；代码风格延续现有模块头注释 + JSDoc。

## 1. 改动前边界清单

每个增量功能开始前，先明确：

```text
问题：用户现在遇到什么具体问题？
目标：完成后用户能观察到什么结果？
非目标：本次明确不做什么？
影响：UI、同步、平台、数据库、权限、导入导出分别是否受影响？
兼容：旧数据库、旧 JSON、旧消息和旧平台是否继续可用？
回滚：出问题时是否能关闭或恢复旧路径？
验收：哪些可操作步骤证明功能完成？
```

仓库正处于兼容式重构中，额外三条铁律：
- **Dashboard 四个页面 View 已完成接入**：`FeedView.vue`、`CreatorsView.vue`、`BookmarksView.vue`、`SettingsView.vue` 承载各自 Tab 模板，通过 context/emits 与 `App.vue` 通信。App.vue 仍保留跨页面组合、全局弹窗和部分应用动作，不能宣称入口层已完全变薄。
- `useDashboardData` 只承载数据加载、媒体修复和统计刷新；回收站刷新仍由 Dashboard 组合流程协调，避免 composable 循环依赖。
- **继续拆分 View 时的既定形状**（`CreatorsView` P4 切片 1–2 已示范）：派生状态与筛选/排序进 `composables/`（依赖以 getter 注入，例如 `creators: () => props.context.creators`，否则 computed 会失去响应式追踪）；纯展示块进 `components/`，**不持有状态**，值与动作经单一 context 契约进出（三套视图共用的动作定义一次，别复制接口）。验收用 `e2e/creators-render.mjs`：改动前后各 `capture` 一次再 `diff`，**要求逐步逐字节相同**；比对时排除已知机械差异（如 `v-model` 只写 DOM property、`:value` 另写 attribute）。探针每步带后置条件断言，否则「点了但没点到」会让对比失去意义。
生产调用方已直接依赖 `src/sync/*`、`src/platform/registry.ts`、`src/infrastructure/db/*`；三个迁移期兼容桶（`src/db/index.ts`、`src/adapters/index.ts`、`src/platform/index.ts`）已于 2026-09-11 删除。禁止重新引入兼容桶或在其位置新增业务逻辑。

开始开发前按顺序阅读：`README.md`（产品与入口）→ `docs/ARCHITECTURE.md`（当前事实与契约）→ 本手册（改动流程）→ 涉及 Dashboard 时再读 `docs/DASHBOARD_MIGRATION.md`。冲突时以源码和 `ARCHITECTURE.md` 的当前状态为准。

> **README 的来源与用法（2026-09-12 用户说明）**：README 由早期开发阶段的 Gemini 起草，
> **内容与方向大致与当时的开发方向一致，但不是本仓库的权威**。
> - 其中的**行为承诺**（「完整备份」「无前置条件」「全部数据」这类）**不得当作决策论据**——
>   已踩过一次：备份 A/B 决策稿曾引 README 的「支持将全部数据导出…便于跨设备迁移或重装恢复」
>   作论据，而该句描述的正是**当时有缺陷的行为**（备份缺删除记录，导入后删除失效，
>   见 `AUDIT_2026-09-12.md` §P0-4）。**该缺陷已于 2026-09-12 修复**（备份格式 1.1 纳入
>   `suppressions`），因此那句话现在成立——但规则不变：**不要用 README 推断意图**。
> - 可核对的事实（平台清单、命令、链接）**直接对代码**；对不上就改 README。
> - **发现原则性问题或方向拿不准 → 停下来问用户**，不要按 README 推断意图。

## 2. 新功能模板（推荐实现顺序）

按数据流从内向外，避免把业务堆进 `App.vue` 和 `background.ts`：

```text
类型/契约（src/types 或模块内类型）
 → 领域规则（过滤/去重/水位/墓碑策略）
 → 应用用例（src/sync/ 或新 composable）
 → Repository / Platform Adapter / 消息 handler
 → Composable（UI 状态与动作，经 actions 注入避免反向依赖）
 → Vue 组件（components/ → 目标 views/）
 → 入口接线（entrypoints/*/main.ts、App.vue 模板、background.ts 路由）
 → 验证（§10）与提交（§11）
```

样例要点（以“在 Dashboard 增加按 XX 过滤”为例）：
1. 若过滤属纯展示，放在拥有该列表的 View：Feed 使用 `FeedView` 接收的 `context.filteredPosts`，Bookmarks 使用 `BookmarksView` 内部的 `filteredBookmarkedPosts`；不要复制一份 posts 数组。
2. 若过滤会复用，再抽到 `entrypoints/dashboard/composables/`；抽离时通过参数/actions 注入依赖（参照 `useDeletedPosts`），保证“搬迁职责、不复制逻辑”。
3. 若该过滤应作用于同步（例如 `onlyOriginal` 语义扩展），改 `FetchOptions` + adapter 读取端，并在 `updateChannel` 的 mergedOptions 链路中生效；UI 只透传。
4. 用户偏好要持久化就进 `AppSettings`（`src/types/index.ts` + `settingsRepository.DEFAULT_SETTINGS`），不要用孤立 localStorage 键；纯 UI 瞬时偏好例外使用 `creator_feed_` 前缀。

## 3. 新增平台接入

1. 在 `src/adapters/` 新建 `<platform>.ts`，实现 `PlatformAdapter` 契约（`src/adapters/types.ts`）：
   - 必实现 `fetchLatest(channel, limit, options)` → 归一化 `FetchResult`（`posts[]`、`authorMeta?`、`nextCursor?`、`hasMore?`、`error?: FetchError`（`{ code, message }`，不是字符串）、`totalFetched?`）。
   - 需要历史翻页 → `fetchHistory?`；需要第二请求通道 → `fetchAjaxFallback?`；需要页内 GraphQL/JSON 归一化 → `parseGraphQLResult?`。
   - **不要在 adapter 里写登录探测**（`checkAuthStatus`）：该模式已于 2026-09-12 删除三处实现——它们零调用，而 Cookie 本来由 `credentials: 'include'` + host_permissions 自动携带，探测既没被调用也改变不了结果。登录状态灯由 `platformAuth.ts` 的 Cookie 表统一负责（见第 7 步）。
   - 平台特有的行为参数放**本 adapter 上**，不要塞进 `sync` 层分支：`minRequestIntervalMs`（请求最小间隔，覆盖只能抬高下限）、`archivesMedia: false`（声明不参与本地图片归档）。理由与形状见 `ARCHITECTURE.md` §4.2。
2. 请求统一走 `src/infrastructure/chrome/http.ts` 的 `bgFetch()`（Background 代理，绕 CORS）；凡 CDN 图/媒体 URL 一律先过 `toSecureMediaUrl()`；热链严格平台按 §8.2 处理。
3. 动态 id 前缀规则：`<platform>_<平台原生 id>`（参考 `bilibili_video_<bvid>`、`xiaohongshu_<noteId>`、`rss_<base64(guid) 32位>` 等），**勿随机数**（youtube 的随机回退仅为异常兜底）。
4. 在 `src/platform/registry.ts` 的 `ADAPTER_MAP` 注册。**`ADAPTER_MAP` 的键类型是 `KnownPlatform`，漏注册会编译报错**（这正是它的作用）；`getAdapter` 对未知平台返回 `undefined`，**没有 rss 回退**——未知平台必须显式报「不支持」，绝不能拿该频道的 URL 当 RSS 源去抓。
   > 更正（2026-09-12）：本步此前写「不要改 `getAdapter` 的 rss 回退语义」。那个回退**早已删除**（见 `AGENTS.md` fix queue 第 8 条、`ARCHITECTURE.md` §4.2），照旧文做会去找一个不存在的分支。
5. 在 `src/types/index.ts` 做**三处**改动（不是一处）：
   - `KnownPlatform` 联合加成员；
   - `KNOWN_PLATFORMS` 运行时常量加成员（`as const satisfies readonly KnownPlatform[]`，与联合互为约束）；
   - `PLATFORM_REGISTRY` 加元数据（name/domain/color/`authType`/`urlPlaceholder`…）。
   三者缺一不可：`ADAPTER_MAP: Record<KnownPlatform, …>` 会因联合成员没有适配器而报错，而 `KNOWN_PLATFORMS` 是给运行时可枚举用的那份。
6. 在 `src/utils/urlParser.ts` 增加 URL → `{ platform, accountId, cleanUrl }` 分支（注意域名顺序：`weibo.cn` 在 `weibo.com` 前等，避免子串误判；XHS 短链 `xhslink.com`、YouTube `youtu.be` 这类别名要并进同平台分支）。
   - **同时把该平台生成的占位名前缀加进同文件的 `GENERATED_NAME_PREFIXES`**。这是**必做项**：`channelSync` 的占位名识别从这份清单派生（`legacyPlaceholderName` / `legacyCreatorPlaceholderName` 用 `.some()` 判成员，没有第二份手写清单），`tests/urlParser.test.ts` 会双向断言「清单 ↔ 解析器实际产出」一致——漏加会让占位名永远不被真实昵称覆盖，且守卫测试会失败。
   > 更正（2026-09-12）：此前不存在这一步，也没有守卫；`AGENTS.md` 规则 9 记的正是漏加前缀导致 8 个平台的昵称写不进去那次事故。派生 + 守卫是本轮（审计 P1-5）的根治。
7. 平台域名：只需把域名加入 `src/infrastructure/chrome/messages/hosts.ts` 的 `PLATFORM_HOSTS`。manifest 的 `host_permissions` 由 `platformHostMatchPatterns()` **派生生成**，图片代理白名单、凭据策略与 Referer 选择同样读取该清单——不要再手写第二份列表（`tests/hosts.singleSource.test.ts` 会断言这一点）。
   - 若走 Cookie 登录：在 `src/infrastructure/chrome/platformAuth.ts` 的 `platformsToCheck` 增加 `{ key, domain, authCookieNames }` 行（登录状态灯）。
   - 若该平台的图片 CDN 需要特定 Referer：在 `hosts.ts` 的 `MEDIA_REFERER_BY_DOMAIN` 增加映射；不需要 Referer 的 CDN 不要加（扩展会发不带 Referer 的请求）。
8. 若走页面令牌（localStorage Token 型平台）：设计 content script 采集 + 受 sender 策略约束的保存/同步消息链路（sender policy 见 `background.ts` `SENDER_POLICY` 与 AGENTS.md 规则 4），不要在 adapter 里直接假设凭证存在。
9. 平台头像/内容走“受限 CDN”：在 `src/infrastructure/chrome/declarativeNetRequest.ts` 增补规则时**必须分配新规则 id**（现占用 1001–1006，remove/add 列表同步扩展，保持幂等）。仅当归宿 CDN 需要改写请求头时才加规则——已在 `MEDIA_REFERER_BY_DOMAIN` 覆盖且代理可用的平台通常无需 DNR。
10. 验证不回归其他平台：增量过滤、去重、墓碑、收藏、图片缓存策略均与平台无关或按平台分支，新增平台不得改变既有分支行为。

Platform Adapter 只负责请求与归一化：**不 import `src/db`/`src/infrastructure/db` 写库、不修改 Vue 状态**；写库统一发生在 `src/sync/channelSync.ts` 的落库段。

### 3.1 埋点与诊断

新增平台或调整请求链路时，按需补 `src/utils/devLog.ts` 埋点（scope 命名见 `docs/ARCHITECTURE.md` §7.1）：

- **必须脱敏**：只记主机名、HTTP 状态码、条数与错误消息；不得记录 Cookie、Token、请求头或响应体——面板的用途就是被截图贴进问题反馈。
- 高频成功路径用 `debug`（默认不记录，用户开启「详细模式」后才留存）；失败与拒绝用 `warn`/`error`。
- 新增失败分支时，确保日志里能看出**是哪一步**失败与**平台返回了什么码**，否则面板无法替代 devtools。

## 4. 数据库变更

入口：`src/infrastructure/db/database.ts`（schema）、`settingsRepository.ts`（默认值）、`postRepository.ts`（生命周期）。

必须遵守：
- 不改库名 `CreatorFeedHubDB`；**不删除/不重排**任何已发布的 version。当前已到 **v6**：v1 四表、v2 posts 复合索引 `[channelId+publishedAt]`、v3 `deletedPostIds`、v4 把 `isRead`/`isBookmarked` 由 boolean 改写为 `0 | 1`、v5 清理存量推文正文尾部的 t.co 链接（后两者均为纯数据迁移，无 schema 变更）、**v6 拆表：`deletedPostIds` → `postSuppressions` + `recycleSnapshots`，旧表置 `null`（整表删除，迁移不可回退）**。完整声明见 `ARCHITECTURE.md` §4.4，设计与不变量见 `DELETION_MODEL.md`。
- 新 schema 只 `version(7).stores({ ... })` 追加，且 stores 里要包含全部受影响表的**完整**索引声明（Dexie 按版本全量替换索引定义）。
- 新增字段一律给旧数据默认兜底：对象型默认值在读取端合并（仿 `getSettings` 的 `{ ...DEFAULT_SETTINGS, ...item.value }`）；布尔/可选字段用 `?.` 与 `Boolean()` 收窄。
- 导入旧 JSON 时允许缺新字段（现有 `handleImportFile` 逐表 `bulkPut`，天然容忍）。
- `Post.id`、`Channel.id` 生成规则不可变；迁移旧数据只允许“同 id 改写字段”，不允许改名。
- 删除动态必须经 `deletePostAndTombstone`（写墓碑+快照），恢复经 `restoreDeletedPost(s)`；**禁止裸 `db.posts.delete`**（同步会复活）。
- 大表操作优先索引：水位查询用 `where('channelId').equals(...).reverse().sortBy('publishedAt')`；存在性判断用 `primaryKeys()` 而不是 `toArray()`（channelSync 已示范）。
- 涉及文件系统缓存句柄的改动与业务库无关：那是独立的 `FeedHubFSCache` 库（`fsManager.ts` 内维护）。

## 5. 消息协议变更（Runtime Message）

协议总表见 ARCHITECTURE.md §6。改动步骤：

1. 先全局搜索该 type 的**发送方**与**接收方**（现网发送方：`infrastructure/chrome/http.ts`、`utils/media.ts`、`popup/App.vue`、`dashboard/App.vue`；接收方：`entrypoints/background.ts` 路由 + `src/infrastructure/chrome/messages/*.ts` handler）。
2. 同步修改五件套：
   - type 名称（涉及两端字符串字面量）；
   - 入参解析与校验（handler 内局部接口 + `typeof` 收窄；外部数据用 `unknown` 收窄，不用 `any`）；
   - `sendResponse` 出参结构（handler 文件顶部注释固化契约，一并更新）；
   - 异步语义：凡 handler 内部是 async 的，必须 `return true` 保持消息通道（bgFetch/proxyImage/twitterTimeline/douyinSnapshot 四个 handler 均如此，新增 handler 照抄）；
   - 发送方错误处理（`chrome.runtime.lastError`、`res` 为空、`ok/success` 为 false 的文案）。
3. handler 不直接承担 Vue 状态或数据库业务；复杂业务抽到 `src/sync` 或独立服务再被 handler 调用（参考 autoSync 的 `setupAutoSync/handleAutoSyncAlarm` 分层）。
4. 同步类消息（如 `UPDATE_AUTO_SYNC`）要能被 Dashboard 设置页即时触发且幂等（先 clear 再 create Alarm 的写法）。
5. 契约变更完成后必须做扩展运行时验证（真实加载扩展跑一遍两端），仅 `tsc` 通过不算数。

现状：App.vue 是跨页面组合层，四个 Tab 已分别由真实 View 承载；仍有部分应用动作与弹窗待继续下沉。拆分工作按以下纪律推进：

1. **一次只搬一个低耦合块**，顺序建议：纯状态 composable → 弹窗/面板组件 → 一个 Tab 的模板段（搬进对应 `views/<Name>View.vue`）→ 该 Tab 的 handlers/computed 随模板同迁 → 删除 `App.vue` 中残留。
2. 抽 composable 用“依赖注入”而非“import App.vue”：`useDeletedPosts(actions)` 是样板——把需要的外部能力以回调参数传入，内部只持有自己的 ref/computed；绝不允许 composable 反向 import `App.vue`。
3. 抽组件：props 收数据、emits 抛动作（参照 `PostCard` 的 `bookmark/delete/read/media/avatarError` 事件）；组件内不允许直接 import `App.vue`，业务动作继续上抛由父级（最终是 composable/App.vue）执行。
4. 拆分是纯搬迁：`git diff` 应表现为“代码位置移动 + import 调整”，不允许顺手改行为、改文案、改样式类（除非 bug 明确）。
5. 每拆完一步立即 `npm run build` + 手动回归对应 Tab；commit 粒度按“一个边界一次提交”。
6. 迁移收尾（已完成，2026-09-11）：兼容桶 `src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts` 已删除；若将来再出现迁移期重导出，收尾时同样以独立提交删除，不要长期维护两套导入路径。

## 6. 增量功能交付模板

每个功能使用独立变更说明，禁止只写“完成重构”这类不可验收描述：

```text
功能名：
问题与用户场景：
目标行为：
非目标与不变行为：
影响面：types / domain / sync / adapter / db / message / UI / permission
契约变更：字段、消息、ID、索引；无变更也必须明确写“无”
迁移策略：旧数据、旧调用方、旧导入文件如何兼容
失败与恢复：超时、限流、网络错误、用户取消、重复执行
实现文件：真实实现与兼容导出分别列出
验证命令：构建、类型、静态检查、运行时手测步骤
验收证据：命令输出、关键页面/消息往返、已知未覆盖项
回滚方式：关闭开关、恢复数据库备份或回退提交
```

提交前必须回答：

1. 是否新增了第二份业务实现？如果是，停止并改为迁移或委托。
2. 是否改变了旧用户数据、动态 ID、收藏/墓碑或消息协议？如果是，补充迁移与兼容验证。
3. 是否把基础设施调用放进了 View 或入口？如果是，移动到应用层/Repository。
4. 验证是否覆盖了实际用户可观察行为，而不仅是类型检查？本轮已完成构建、类型与纯函数冒烟；真实扩展点击回归因用户明确禁止操作当前浏览器而保留为未覆盖项。
5. 文档是否准确描述“已完成”与“迁移中”的边界？

## 7. 变更记录格式

```text
日期：YYYY-MM-DD
变更：一句话
行为保持：列出关键不变契约
结构变化：列出新增模块、兼容入口和依赖方向
验证：实际执行的命令和结果
风险：未覆盖的运行时平台或权限场景
```
## 8. 平台请求与图片

### 8.1 请求纪律
- 一切跨域走 `bgFetch()`；扩展环境不要直连 `fetch`（页面 CORS / 受限头会失败）。
- `fetch` 无法手工设置 `Cookie`/`User-Agent`/`Referer`/`Origin` 等受限头：B 站登录靠 `credentials:'include'` + host_permissions 自动带 Cookie；UA 用浏览器自己的。不要把 UA/Referer 塞进 BG_FETCH headers 期望生效。
- 遵守平台节流：adapter 不做无界循环；批量/深挖的间隔由 sync 层保证（§8.3 表）。

### 8.2 图片三件套
- 入库前：`toSecureMediaUrl()` 归一化（协议补全、小红书 avatar → `sns-avatar-qc.xhscdn.com`、XHS 永久 fileId 直链等已在 `utils/media.ts` 处理，改动先读该文件与 `postRepository.healBrokenPostMedia`）。
- 渲染失败：先 `markImageFailed`，再 `proxyImage()`（`PROXY_IMAGE` 消息、候选 URL 列表、data URL）；不要在组件里重复实现 base64 转换（`handleProxyImage` 已有，含 8192 分块避免栈溢出）。
- 离线缓存：`src/services/imageCache/`（File System Access）。写盘只在用户绑定目录后；目录选择必须由用户手势触发；路径分段由 `resolvePostDirSegments` 决定（`[创作者名, 平台中文名, YYYYMMDD_短id]`），文件名经 `sanitizePathSegment` 净化。
  - **新平台默认参与归档**；只有在「这个平台的图片存下来没有意义（源可随时重取，或托管方一律拒绝外站引用）」时才在 adapter 上声明 `archivesMedia: false`（见 `rss.ts`）。门在 `cacheMediaItem`/`cachePost` 的入口，卡片的自动保存与批量归档共用，不要在 UI 侧另加判断——两处条件必然分叉（AGENTS 规则 1 的同类失败模式）。**读取侧不加门**：已归档的文件必须继续可读。
- DNR 规则 id 空间：1001–1006 已占用，新规则从 1007 起；`removeRuleIds` 列表与 `addRules` 必须同步更新，保持幂等。

### 8.3 同步保护速查（改动冷却/间隔前先看）

| 语义 | 现值 | 位置 |
|---|---|---|
| 单频道成功冷却 | 30 s | `sync/channelSync.ts` |
| 单请求超时 | 45 s | `sync/channelSync.ts` |
| 历史到底 | `nextCursor='__END__'` | `sync/channelSync.ts` |
| 批量同平台最小间隔 | 800 ms 默认 | `sync/batchSync.ts`（`minPlatformIntervalMs`） |
| updateCreator 间隔 | 600 ms | `sync/batchSync.ts` |
| 深挖每轮 / 轮间 | 20 条 / 900 ms | `sync/historySync.ts` |
| 深挖空轮上限 | 4 | `sync/historySync.ts` |
| 自动同步周期 | 30 min Alarm | `infrastructure/chrome/autoSync.ts` |
| 未读角标 | 上限 999、色 `#4f46e5` | `infrastructure/chrome/autoSync.ts` |

调小即提高风控风险：**只允许在明确产品决策下改动，并更新本表。**

## 9. 安全与隐私红线

- 扩展申请的权限以 `wxt.config.ts` 为唯一来源：`storage/cookies/activeTab/scripting/declarativeNetRequestWithHostAccess/alarms`；`host_permissions` 由 `PLATFORM_HOSTS` 派生，RSS 站点走 `optional_host_permissions`。**没有 `tabs`**（2026-09 移除），不要以「读标签页 URL」为理由加回来——平台标签页由 host 权限覆盖。新增平台/域必须先问“是否最小必要”，host permission 只加实际请求与 `<img>` 直连的域。
- 不要在源码、备份 JSON、日志中夹带用户 Cookie/Token/密钥。x.com guest bearer token 是公开常量（已内联在 `twitterTimeline.ts`），不要把它误当密钥挪进配置。
- `scripting.executeScript` 注入的函数体必须是**自包含纯函数**（序列化传参，如 twitterTimeline 的 tab func），不要从扩展作用域捕获敏感对象；执行前对目标 URL/平台做白名单判断，禁止对任意页面注入。
- 对 `chrome://`、`edge://`、`about:`、`devtools:` 页面一律跳过 DOM 注入（Popup 已有该判断，新增注入点照做）。
- 外部数据（平台 HTML/JSON、备份文件、消息载荷）一律当作 `unknown`/不可信输入：解析用可选链 + 类型收窄 + try/catch，禁止把响应直接当强类型用；新边界不用 `any`。
- 删除类操作必须二次确认；清理动态不得触碰 `isBookmarked`（`cleanupOldPosts` 语义）；恢复操作前如有同名 id 用 put/bulkPut 覆盖语义而非报错。

## 10. 验证规范

- 构建/类型/Lint：`npm run build`、`npm run typecheck` 与 `npm run lint` 必须通过（CI 三件套 + lint）。类型检查用原生 TS7 编译器（`@typescript/native` 别名），ESLint 工具链经 `typescript: npm:@typescript/typescript6` 官方兼容别名消费经典 API（见 `eslint.config.js` 头注释）。
- 加载方式：`chrome://extensions/` 开发者模式加载 `.output/chrome-mv3/`，代码更新后重新构建并点“重新加载”；扩展页不更新先怀疑旧产物。
- 消息/后台改动必须**扩展运行时验证**（Popup/Dashboard ↔ background 真实往返），纯 `tsc` 通过不算。
- 最小手动回归清单（按改动面裁剪）：
  - Popup 打开并识别一个平台主页；
  - 新建创作者并绑定平台账号（首轮同步触发）；
  - Dashboard 加载既有动态；单频道/单创作者/全部刷新；强制刷新；
  - 历史翻页与深度回溯、到底标记、中止；
  - 收藏、已读、删除→回收站→还原/彻底删除、清理旧动态；
  - 标签/平台/隐藏/转发/纯文字过滤与搜索；
  - 导出 JSON 并重新导入；
  - 图片直连/代理回退/失败占位/本地磁盘缓存绑定与批量缓存；
  - 自动同步开关与未读角标。
- 无法运行扩展的场景：用**一次性脚本**做单元冒烟（例如非扩展环境 `bgFetch` 的直连兜底、纯函数如 `parseProfileUrl`/`toSecureMediaUrl`/`interleaveChannelsByPlatform`），跑完即删，不留在仓库当测试。
- 需要**真实浏览器**才能回答的行为（页面渲染、排版、滚动、真实平台报文），用 `e2e/` 下的 CDP 探针脚本，详见 [e2e/README.md](../e2e/README.md)：
  - **发布前门禁**：`npm run build && npm run e2e`（`e2e/release-gate.mjs`）。它自建独立 profile 加载构建产物，跑「备份导出/导入往返 + alarm 存活」三段，`release.yml` 在发布前会跑它；CI 无显示环境用 `xvfb-run -a`。产物版本与 `package.json` 不一致会直接失败，防止拿旧 `.output` 放行。
  - **版本号语义与商店重提交**（第 4 位数字、什么时候加 MAJOR/MINOR/PATCH）写在 `docs/PUBLISHING.md` §5；上架相关的一切都集中在那一份文件里，不要在本文件重复。
  - 必须指向**独立 profile** 的调试端口，绝不接管用户日常浏览的实例；
  - 已固化的门禁脚本自己启动/收尾浏览器与临时 profile；手跑探针只读，不点击、不提交、不修改扩展数据；
  - 本机 Chrome 152 起 `--load-extension` 被忽略，不能用它加载未打包扩展；**但 CDP `Extensions.loadUnpacked` 可用**（需 `--enable-unsafe-extension-debugging`），可做扩展级验证；纯排版问题则把组件打包成单文件 HTML 在普通页面中量（见 `AGENTS.md` 规则 28/30）。
- 性能改动自检：优先既有索引（`[channelId+publishedAt]`、`isBookmarked` 等），不新增全表扫描式展示查询；UI 不重复拉取同一批数据；批量写用 `bulkPut/bulkDelete`；存在性判断用 `primaryKeys()`；内存里复制大数组前先想清楚是否必要。
- 新测试只为一个真正不确定的边界而写（例如新平台日期解析、水位/去重交互）；不要为了“有测试”而写。断言可观察契约与真实错误，不钉实现细节。
- **fixture 必须来自真实报文。** 这条不是风格问题，而是规则 15/21 的翻车点：按“解析器当前读什么”手写的 fixture，只证明解析器与自己一致——Twitter 的 `tweet_results` 双层嵌套 bug 就是这样被固化成“期望行为”，并穿过了 typecheck、lint 与全套测试。
  - 至少要有一份**逐字抓取**的真实载荷（`tests/fixtures/` 下已有 `douyin/`、`rss/` 两个目录，照此放）。
  - fixture **必须包含修复所依赖的字段**。曾有一次修复之所以长期无法被测试发现，是因为 fixture 里恰好缺了那个字段（media entity 的 `url`），于是测试与实现互相点头、与真实报文无关。
  - 注释里断言上游行为（“某字段的含义是…”）而没有真实载荷支撑，就是**披着引用外衣的猜测**；要么附上 fixture，要么删掉断言。
  - 本仓现状：已有逐字真实载荷的平台是 **RSS、抖音、bilibili、小红书**（`tests/fixtures/` 下各自一目录），应作为模板；Twitter 的 fixture 仍是 `tweetEntry()` 手工构造的，其文件头自己记录了它曾把 bug 编码成期望值。下次拿到真实载荷时，抓一份逐字副本与现有构造式 fixture 并存。
- **有意不补测试的模块要写下来，否则下次会被当成疏漏**：
  - `youtube.ts`（**121 行**）：**RS​S 解析部分有意不补**。它是官方 `feeds/videos.xml` 上的一个平直 `filter().map()`，每个字段都带 `||` 默认值（`title`/`published`/`desc` 均为空串兜底，`publishedAt` 用 `Number.isFinite` 兜底），**没有“解析一半”的中间状态**——而后者正是其他平台测试存在的理由（Twitter 的嵌套层级、微博的字段别名、抖音的网格形状都属于这一类）。测试一个不可能退化到另一种形状的映射，只会钉住实现细节。
  - **但同一文件里真正脆弱的一段没有被测试**，这条例外不覆盖它：`@handle → channelId` 的解析是**三个正则依次兜底**（`feeds/videos.xml?channel_id=` / `<link rel=canonical>` / 内联 `"channelId":"UC…"`），跑在 YouTube 页面 HTML 上。三个全 miss 时 `channelId` 保持 `@handle` 原样，接着就用它去请求 RSS。
**2026-09-12 已实测，结论是好的那一种**：`feeds/videos.xml?channel_id=@nonexistent_handle_zzz`
返回 **HTTP 404**（`UCabcdefghijklmnopqrstuv` 同样 404），所以适配器抛出并返回 `network` 错误——
**不会**变成「成功但 0 条」那种不可信的零（规则 13 合规）。
`tests/youtube.handle.test.ts`（5 例，jsdom，因为适配器用 `DOMParser`）逐条钉住三个正则分支＋这条 404 行为，
并记录了一个实测细节：`og:title` 优先于 `<title>`，且**只有** `<title>` 分支会剥掉「 - YouTube」后缀。
  - `withny.ts` 曾在此名单内，**2026-09-12 随平台整体移除**（队列 B30）。
- **曾经的缺口已补上（2026-09-12）**：`bilibili.ts` 与 `xiaohongshu.ts` 原先分支密集、零测试。两者**都先抓了逐字真实载荷做 fixture，再提纯解析段，最后断言同一份 fixture 解析结果不变**（顺序见提交 `342ce6c` → `e4c8b56` → `bc0ffc3`、`06f30c7` → `272a989` → `d8b6c1`）。
  - 现有回归网：`tests/bilibili.parse.test.ts`、`tests/xiaohongshu.parse.test.ts`、`tests/xiaohongshu.enrich.test.ts`，载荷在 `tests/fixtures/bilibili/`、`tests/fixtures/xiaohongshu/`。
  - 提纯过程中真实抓到过一个缺陷：小红书同时存在两个提取器，行为不一致——这正是「先建网再动刀」要防的那类回归。
  - 仍需注意：fixture 覆盖的是**实测到的形状**，平台改版后要先补新载荷再改解析。

## 11. 提交规范

提交前逐项确认：

```text
[ ] 未改变数据库库名、已有 schema 版本或动态/频道 id 规则
[ ] 未改变 Runtime Message 名称与返回结构，或已迁移全部发送方/接收方并运行时验证
[ ] 新平台未直接写数据库或修改 Vue 状态
[ ] 兼容 import 路径仍有效，或已完成全部调用方迁移
[ ] 没有复制同步/数据库逻辑，没有新增无意义兼容别名
[ ] 没有声称未完成的 Dashboard View 重构已完成（文档/PR 描述如实）
[ ] npm run build 通过；相关核心流程已手动回归
[ ] git diff --check 通过
[ ] git status --short --ignored 未包含数据库、凭证与构建产物（.output/、.e2e-profile/ 等已忽略）
```

```bash
git diff --check
git status --short --ignored
```

提交粒度：单功能或单结构边界一个 commit，信息用描述性中文或现有提交风格（如 `feat(cache): …`、`fix(media): …`、`docs: …`）：

```bash
git add .
git commit -m "feat(xxx): 描述变更"
git push
```
