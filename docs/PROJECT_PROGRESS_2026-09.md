# Chorus 项目进步与剩余不足 — 2026-09

## 结论

本阶段最初目标是修复代码审查发现的 28 个问题，并完成修复队列 1–12。

项目已经从“功能覆盖较广，但安全边界、后台同步和数据索引依赖隐含假设，且缺少持续验证”，提升为：

> 具备明确安全边界、稳定数据契约、可解释同步流程、基本性能治理和持续集成的可维护 Chrome MV3 扩展项目。

本阶段最大的价值不是新增功能，而是让多个“表面存在、实际可能静默失效”的功能具备正确的实现基础，并把关键规则固化为代码契约和自动化测试。

尚未达到的状态是：完成真实 Chrome 端到端验证、最小化权限、完整数据 schema、统一平台描述协议、成熟外部 API 策略和完整工程静态检查的发布级产品。

> **追加记录（2026-09-10，第二批）**：Rplay 平台整体移除（`389b007`，-840 行），
> P5 ESLint（`acf3b8a`）与 P2 Dexie migration 永久测试（`620129e`）完成。
> P3（收窄 Rplay token 姿态）随平台移除整体作废；测试增至 129 项（15 个文件）。
> 相关内容见一.12/二.8 注记与四.P2/P3/P5 状态更新，原文其余部分保持不变。

> **追加记录（2026-09-10，第三批）**：真实 Chrome 中展开系统性界面走查，三轮共 14 项发现
> 全部修复（`8465887` 九项、`e2d9923` 两项、`d4e031e` 三项，合计 +655/-138、14 文件）。
> 内容见一.13。P0「日常路径无阻塞」的结论不变，但「P1 无处理项」判定过早，见四.P0/P1 修订。
> 当前验证：typecheck / lint / 129 项测试 / production build 通过；master 领先 origin 3 个提交未推送。


---

## 一、相对最初状态的主要进步

### 1. 安全模型从隐式假设变为显式代码边界

最初，后台请求安全依赖 manifest 当前没有开放外部连接、调用方按约定传入安全参数，以及 URL 字符串中是否包含平台域名。

现在：

- URL 必须是 HTTP(S)。
- URL 不能包含 embedded credentials。
- 平台身份通过解析后的 hostname 精确或合法子域匹配。
- 平台 allowlist 只控制凭据，不限制用户 RSS 地址的可达性。
- BG_FETCH 固定为 GET。
- 调用方不能控制 credentials。
- privileged runtime message 集中验证 sender。
- 未知 message type 默认拒绝。
- DNR 只作用于扩展发起的请求。

项目不再依赖“当前配置大概安全”，而是由代码自身验证调用者、URL、方法和凭据策略。

### 2. 两个长期静默失效的核心功能获得根本修复

#### unread badge 与 bookmark 统计

IndexedDB 不为 boolean 建立有效索引项，旧实现却把 `isRead` / `isBookmarked` 作为 boolean 写入索引字段，导致查询永久返回 0 且没有异常。

现在：

- 持久化类型统一为 `0 | 1`。
- adapter、repository、UI 和查询保持一致。
- Dexie v4 migration 修复旧 posts。
- recycle-bin snapshots 同步迁移。
- 索引查询经过真实升级链验证。

#### 自动同步

最初同时存在两个断点：Service Worker 启动会重建并重置 alarm；alarm 即使触发，Service Worker 又会向自身发送无法接收的 BG_FETCH message。

现在：

- alarm 只在缺失或周期变化时创建。
- Service Worker 直接调用后台 fetch 实现。
- 页面路径继续经过受保护的 message router。
- 自动同步复用批量限速流程。

### 3. 数据写入策略从“尽量存入”变为“拒绝污染”

最初存在随机 Post ID、`undefined` 拼接 ID、Unicode guid 经 `btoa()` 抛错，以及 NaN 时间戳进入排序、水位线和数据库索引等问题。

现在：

- 无稳定身份的条目直接跳过。
- RSS 使用稳定 UTF-8 哈希。
- 不再使用随机 Post ID。
- 缺失 ID 不再生成碰撞键。
- 日期解析在持久化前检查有限数值。
- `buildPost()` 统一 13 处 Post 构建骨架并固定 `isRead: 0`。

同步系统现在宁可不保存无法可靠识别的数据，也不写入不可去重、不可排序或不可索引的记录。

### 4. 错误处理从文本匹配升级为机器可读契约

最初 `FetchResult.error` 是任意字符串，同步层通过搜索 `429`、`403`、“已到达”等文案决定控制流，导致业务逻辑依赖本地化文本。

现在：

```ts
interface FetchError {
  code:
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'parse'
    | 'timeout'
    | 'not_found'
    | 'unsupported';
  message: string;
  retryable?: boolean;
}
```

结果：

- 同步层使用 code，UI 使用 message。
- 文案变化不再影响业务控制流。
- 未知平台明确报错，不再静默按 RSS 处理。
- 历史同步只有收到明确 `hasMore === false` 才确认结束。
- 后续统一 retry/backoff 已具备稳定基础。

### 5. 备份恢复成为真正的数据入口边界

最初仅检查 section 是否为数组或对象，version 和记录关键字段未验证，损坏数据可能直接进入 Dexie。

现在导入前验证：

- 顶层类型。
- format version。
- section 类型。
- 记录关键身份字段。
- 最多报告前五条坏记录。
- 任一错误即整体 fail-fast，不发生部分导入。

虽然尚未达到完整 JSON Schema，但已能阻止常见损坏或异构备份。

### 6. 查询代码开始正确使用已有索引

最初数据库已经建立索引，业务代码却继续全量加载和排序：

- watermark 物化整个 channel posts。
- tombstone 每次同步扫描全库。
- Bilibili 去重全量 `toArray()`。

现在：

- watermark 走 `[channelId+publishedAt].last()`。
- tombstone 走 `channelId` 索引。
- Bilibili 去重按 channel 流式扫描，只收集 stale IDs。

同步成本更接近单个 channel 的必要数据规模，而不是整个历史库规模。

### 7. 分层和重复代码得到实质收敛

完成：

- popup 写入走 creator/channel application services。
- cookie-auth 表由 `platformAuth.ts` 单一维护。
- `buildPost` 统一 Post 构建。
- recycle-bin 清理走 repository API。
- 零调用 facade 删除。
- composition root 的只读装配有意识保留，避免无语义的一行 wrapper。

项目不再为了形式上的分层同时维护两个合法写入入口。

### 8. UI 弹窗具备统一交互和可访问性契约

最初六个 modal 各自维护 overlay，没有 focus trap、focus restore、scroll lock 和统一 Escape 行为。

现在共享 `BaseModal` 提供：

- `role="dialog"`。
- `aria-modal="true"`。
- Escape 关闭。
- Tab / Shift+Tab 焦点圈定。
- 打开后首焦点。
- 关闭后焦点恢复。
- body scroll lock。
- 可配置 backdrop 行为。

六个 modal 已迁移，并保留各自原有 backdrop 关闭语义。

### 9. 项目首次具备持续回归防线

最初没有 test、CI、typecheck script，TypeScript 版本也通过范围浮动。

现在 CI 执行：

```text
npm ci
npm run typecheck
npm test
npm run build
```

现有 106 项测试（9 个文件）覆盖（后续批次增至 129 项通过 / 15 个文件，见文首追加记录）：

- hostname 与 sender 安全边界。
- 仿冒 host 回归。
- FetchError 和 buildPost 契约。
- backup validation。
- UI 组件 SSR。
- BaseModal dialog semantics。
- 抖音：解析与稳定 ID、历史回溯语义（截断不上 `__END__`）、popup 快速关注、live 采集安全边界。

TypeScript 固定为 `7.0.2`。关键缺陷不再只依赖维护者记忆。

### 10. 云端仓库隐私和整洁性提升

完成：

- 未来 Git 提交使用 GitHub noreply 邮箱。
- `.gitignore` 覆盖环境文件、密钥格式、数据库、备份、日志、HAR、浏览器 profile 和构建产物。
- 阶段报告使用仓库相对路径。
- 安全审查改为适合公开仓库的结论版。
- 删除产品无关的内部 agent 调度记录。

### 11. 抖音：第一个页面驱动平台（追加于 2026-09-10）

抖音无法从 Service Worker 采集（后台请求创作者主页只会得到反爬 JS 挑战外壳），因此引入了第二种采集架构：

- **三层隔离**：`douyin/collector.ts`（注入页面的只读采集器，无导入、无 `chrome.*`、只读渲染 DOM）→ `douyin/contract.ts`（不可信快照校验：数量/长度界限、协议与 CDN 域名白名单、稳定 ID 与有限时间戳）→ `douyin.ts`（经 `buildPost` 映射）。页面数据全部视为不可信输入。
- **零凭据**：不读取 Cookie、Token、请求头或设备指纹；仅注入已打开的抖音标签页读取渲染结果。
- **稳定身份**：以 `aweme_id` 为唯一身份，发布时间取其 snowflake 高 32 位，不依赖易变的页面文案；签名 CDN 地址只作展示用不作身份。
- **历史回溯**：驱动页面内真实滚动容器（`.route-scroll-container`）而非 window 载入更早作品；匿名访问被截断时明确报告「只加载出 X / Y 篇」且绝不写入 `__END__` 游标，登录后可续挖。
- **占位名前缀**：`channelSync.ts` 两处前缀列表均已补齐抖音（`抖音用户_`/`抖音作品_`）。
- **sender 校验**：`FETCH_DOUYIN_SNAPSHOT` 进入 background 路由的 sender policy 表，仅扩展自身页面可调用。
- **自动同步语义**：需要真实页面参与，后台定时任务返回明确的 unsupported 状态，不会伪装成「同步成功 0 条」。

### 12. Rplay 平台移除与质量加固收官（追加于 2026-09-10，第二批）

**Rplay（rplay.live）整体卸载**（`389b007`，30 文件 -840 行）：

- 删除 adapter、rplaySync handler、content script、popup 同步横幅与 composable 五个整文件；
  Platform union、注册表、`PLATFORM_HOSTS`、host_permissions、proxyImage 正则、urlParser 分支、
  channelSync 占位名前缀与 platformAuth 凭证分支全部清空。
- 凭证卫生：`onInstalled` 时幂等清除孤儿 `rplay_auth_token`。
- 数据兼容：IndexedDB 中已有 rplay 频道/动态不删（用户数据不未经询问销毁）；
  `getAdapter` 对残留 `rplay` 频道返回 undefined → channelSync 归类为 unsupported 错误，
  UI 各消费点经 `?.name || platform` 兜底优雅降级。
- `isContentScriptSenderOn` 作为 AGENTS.md 规则 4 的参数化通用模式保留，测试向量换中性 host。

**P5 ESLint**（`acf3b8a`）：最小 flat config（js/ts recommended 非 type-aware + vue essential，
模板布局规则显式关闭避免全仓格式重写）。TypeScript 7.0.2 无编译器 API，按官方公告采用
`typescript: npm:@typescript/typescript6`（经典 API 供 lint 工具链）+ `@typescript/native`（TS7 tsc）
双别名共存。首轮 77 错误全修零抑制，其中捕获一个真回归（Rplay 清理误删 dashboard
settingsContext 六个字段，SettingsView 静默渲染 undefined）与一个真 bug
（ChannelRow 刷新按钮 `@click` 与 `@click.shift.stop` 并存导致普通点击双触发）；
38 处裸 `any` JSON 遍历收敛为共享 `JsonRecord`/`asRecord` 工具（`src/utils/json.ts`）。
lint 步骤已接入 CI。

**P2 Dexie migration 永久测试**（`620129e`）：`tests/dexie.migration.test.ts`（3 用例，
fake-indexeddb 驱动真实升级链）——v3 布尔数据（含墓碑快照）升级后全为 `0|1`、
索引查询真实命中迁移后行、全新数据库安装路径可用。v4 schema 内联声明独立钉死迁移契约。


抖音阶段沉淀的 AGENTS.md 第 9/10 条通用工程规则（页面驱动平台隔离层约定、先探测真实滚动容器再下「无分页」结论）继续适用。

### 13. 真实 Chrome 走查与第三批 UI 修复（追加于 2026-09-10）

P0 日常使用验证通过后，同日在真实 Chrome 中按界面逐项走查，三轮共 14 项发现并全部修复：

**`8465887` — 走查第一轮（9 项）**

- 缺陷：grid 卡片账号数切换退化为裸数字（恢复 pill 外观）；「检测登录状态」按钮无任何
  反馈（补 `isCheckingLogins` 状态、spinner、防重入）；Rplay 移除时引入「护限流」错字。
- 统一控件：三处原生 `<select>` 与卡片风格不符，新增 `AppSelect.vue`（键盘 Enter/Space/
  ↑/↓/Esc、点击外部关闭、勾选标记），创作者排序与设置页两处消费。
- 自定义排序：侧边栏平台列表可拖拽排序，持久化到新增 `AppSettings.platformOrder`；
  创作者新增「按平台分组」与「手动排序」（三视图拖拽，经
  `creatorRepository.updateCreatorsSortOrder` 单事务持久化 `Creator.sortOrder`）。
- 书签筛选：搜索支持 #标签，新增账号角色筛选行（角色取自书签动态实际所属 channel）。
- 图片归档增量：`isPostFullyCached()` 磁盘探测使已完整缓存的作品跳过网络；三路 worker
  池（单点失败不中断整批）；进度显示新/跳过/失败计数并在汇总中分别报告。

**`e2d9923` — 走查第二轮（2 项）**

- 账号数徽章与平台徽章行风格冲突：改为卡片操作图标语法（Users 图标按钮 + 数字角标 +
  展开角标）。
- 创作者工具栏占用整行：标题与操作组压缩为单行 flex-wrap，节间距 6→4。

**`d4e031e` — 走查第三轮（3 项）**

- grid 账号切换改为轻量内联标签（N 个账号 + chevron），去掉盒子与斜角装饰。
- compact 列表：标签移出创作者单元格成为独立「标签」列（完整列表而非前 2 个）；
  「查看全部 (N)」右对齐使跨行对齐；展开行列数 colspan 5/6 → 6/7。
- 创作者管理新增「账号类型」筛选行（主账号/小号/里号/自定义，含各角色计数）。
- 顺带收敛：账号角色标签/顺序/徽章样式原在 `ChannelRow`、`useCreatorsManager`、
  `BookmarksView` 三处重复，提升为 `src/types` 的 `ACCOUNT_ROLE_ORDER` 等单一导出，
  四处调用点统一消费。

性质说明：14 项中 3 项为真实缺陷，其余为交互与信息密度改进；`8465887` 同时消除了三处
原生控件风格分裂与三处常量重复。

---

## 二、仍然存在的不足

### 1. 曾经的最大证据缺口：真实 Chrome 扩展 E2E — 已补（2026-09-10，见四.P0）

已完成 TypeScript、Vitest、Vue SSR、production build 和一次性 Dexie migration 实验，但这些不能完整验证：

- 真实 `chrome.runtime.MessageSender` 字段。
- DNR 是否实际命中。
- Service Worker 生命周期。
- alarm 是否按周期触发并跨 worker 回收保持。
- cookie 与 host permission 行为。
- content script、popup、dashboard 和 background 通信。
- Twitter tab 注入。
- modal 的真实键盘焦点行为。

人工验证是从“代码层完成”进入“产品层完成”的必要步骤。

> **已验证（2026-09-10）**：扩展已在真实 Chrome 中加载并投入日常使用，未观察到影响使用的异常。
> 性质为实际使用验证，非逐项 checklist 演练；备份全量导出导入与 alarm 跨浏览器重启的长期行为未单独专项演练。
>
> **补充（2026-09-10，第三批）**：随后按界面逐项走查仍发现 14 项 UI/交互问题（见一.13），
> 说明「无影响使用的异常」只覆盖日常路径，不能替代逐项走查。备份全量导出导入与 alarm
> 跨浏览器重启的长期行为仍未专项演练。

### 2. `CreatorsView.vue` 仍然较大

文件从 1420 行缩减到约 1100 行，主要重复块已提取，但仍同时承担：

- 搜索与排序。
- 标签三态过滤。
- 批量模式。
- masonry 分列。
- Grid/List/Detailed 三种主模板。
- 同步状态聚合。

后续合理拆分方向：

- `useCreatorDirectoryFilters`
- `CreatorDirectoryToolbar`
- `CreatorGridView`
- `CreatorListView`
- `CreatorDetailedView`

### 3. UI 拆分可能存在轻微视觉差异

需要人工确认：

- detailed 标签区域位置。
- compact ChannelRow 的平台辨识度。
- detailed 账号头像 URL 处理。
- detailed header 的作品数位置。
- flex wrapping 和局部间距。

编译和 SSR 只能证明模板可用，不能证明像素等价。

### 4. FetchError 分类仍可提高精度

部分 adapter 使用宽范围 `try/catch`：

- JSON/XML parse error 可能归类为 network。
- 未特殊处理的 401/403 可能归类为 network。
- 平台返回格式变化可能没有归类为 parse。
- `retryable` 尚未驱动实际重试。

后续应按 HTTP、解析、schema、timeout 和 transport 阶段分别分类，再统一实现受限指数退避。

### 5. 备份验证不是完整 schema

尚未验证：

- 所有字段的完整类型和范围。
- timestamp 必须为有限数。
- platform 必须属于支持枚举。
- channel→creator 和 post→channel 的引用完整性。
- 重复 ID。
- settings 的字段范围。
- `isRead` / `isBookmarked` 必须为 0|1。

### 6. 新增平台仍涉及多个配置点

新增平台仍可能需要同步修改 adapter、registry、platform metadata、URL parser、host allowlist、manifest permission、cookie auth、proxy-image policy 和 DNR。

未来出现真实新增平台需求时，可评估统一的 `PlatformDefinition`；当前不应为预想需求提前增加复杂抽象。

### 7. Twitter/X 路径先天脆弱

该路径依赖网页客户端常量、未公开 GraphQL operation ID、用户页面会话和非公开响应结构。

潜在影响：

- 服务端 operation ID 或响应 shape 变化。
- 页面 CSP 或上下文变化。
- Chrome Web Store 审核和平台服务条款风险。
- 账号风控。

这些属于外部平台依赖风险，无法仅靠本地重构消除。

### 8. Rplay Token 运行时姿态 — 已随平台移除关闭（2026-09-10）

原记录：运行时把完整 token 保存在 `chrome.storage.local` 并短暂进入 UI reactive state。
Rplay 平台整体移除后该路径不复存在：token 在 `onInstalled` 时被幂等清除，
「收窄 token 姿态」（原 P3）无对象，作废。以下原文留存备查：

- UI 长期只维护 `hasToken`。
- 需要编辑时即时读取。
- 设置页只显示“已配置”。
- 保存 expiry。
- auth failure 时标记或清除失效凭据。

### 9. host allowlist、manifest permission 和 proxy policy 仍是多个来源

`hosts.ts`、`wxt.config.ts` 和 proxy-image policy 尚未由同一静态定义生成。

潜在问题：

- runtime 允许但 manifest 无权限。
- manifest 有权限但 credential policy 未同步。
- fetch 可用但图片代理拒绝新 CDN。

其中 `proxyImage` 仍有自己的安全 hostname 正则，虽不是 substring 漏洞，但仍存在维护分裂风险。

### 10. 权限仍可能偏宽

当前功能使用 cookies、tabs、activeTab、scripting、declarativeNetRequest 和多个 host permissions。

后续应在真实 Chrome 行为验证后评估：

- `tabs` 是否可移除。
- RSS 是否适合 `optional_host_permissions`。
- 是否采用 `declarativeNetRequestWithHostAccess`。
- 如何降低 Chrome Web Store 安装提示与审核风险。

### 11. ESLint — 已引入（2026-09-10，见一.12 与四.P5）

原记录：CI 无法系统约束 floating Promise、新增 `any`、层次违规、死代码和高复杂度条件。
现状：最小 flat config 已上线并接入 CI（`npm run lint`），首轮 77 处错误全修零抑制。
type-aware 规则与格式化规则有意未启用（见 `eslint.config.js` 头注释），后续可作为增量项。
以下原文留存备查：

- floating Promise。
- 新增 `any`。
- 层次违规。
- 死代码。
- 高复杂度条件。

### 12. Dexie migration — 已进入永久 CI（2026-09-10，见一.12 与四.P2）

原记录：v3→v4 曾用真实 Dexie 升级链验证，但一次性脚本已清理。现状：
`tests/dexie.migration.test.ts` 已将其固化为永久回归测试（fake-indexeddb 真实升级链）。
以下原文留存备查：

- 建立 v3 数据库。
- 写入 boolean posts 和 tombstone snapshots。
- 用当前数据库类打开。
- 断言值转换为 0|1。
- 断言索引查询命中。

### 13. 抖音路径的固有约束（追加于 2026-09-10）

抖音采集依赖真实页面的渲染 DOM，由此带来与其余平台不同的边界：

- **同步前置条件重**：需要用户在浏览器打开目标创作者主页并保持标签页开启；后台定时任务无法独立完成，自动同步对抖音形同虚设。
- **DOM 结构耦合**：页面改版（滚动容器类名、网格节点、封面/标题选择器变化）会直接破坏采集器，且只能在真实页面中发现——fixtures 无法预警。
- **匿名截断**：未登录时抖音只放出部分作品（实测 18 / 29），剩余历史必须登录后才能回溯。
- **capability 边界**：与 Twitter 路径同属「借真实页面绕过反爬」的方案，平台风控升级或页面架构变化都可能使其失效，属于无法靠本地重构消除的外部依赖风险。

---

## 三、当前成熟度判断

### 本阶段之前

> 功能覆盖较广的个人扩展；核心功能可用，但安全和数据一致性依赖隐含假设，缺少持续验证。

### 本阶段之后

> 具备明确安全边界、稳定数据契约、可解释同步路径、基本查询性能治理和持续集成的可维护扩展项目。

### 尚未达到

> 具备完整真实浏览器 E2E、权限最小化、完整 schema、统一平台描述、成熟可观测性和稳定外部 API 策略的发布级产品。

---

## 四、后续优先级

### P0：真实 Chrome 人工验证 — 已完成（2026-09-10）

实际使用验证通过，日常路径未发现问题。P0 收口时曾判定「P1 无处理项」；随后逐项走查
产生 14 项发现，P1 因此重新打开并已完成（见下）。原 checklist 留存备查：

1. 加载 `.output/chrome-mv3`。
2. 检查 Service Worker 控制台。
3. 检查 Grid/List/Detailed。
4. 检查六个 modal 的焦点、Escape、backdrop 和滚动恢复。
5. 检查微博、Pixiv、小红书媒体资源。
6. 手动同步主要平台。
7. 检查 unread badge 和 bookmark。
8. 导出并重新导入备份。
9. 检查 alarm scheduled time。
10. 抖音：打开创作者主页标签页后触发同步，验证注入采集、昵称/头像恢复（含 popup 快速关注）、封面经图片代理加载、历史回溯的滚动容器驱动与「X / Y 篇」截断提示。

### P1：真实 Chrome 走查修复 — 已完成（2026-09-10）

三轮走查共 14 项发现（`8465887` / `e2d9923` / `d4e031e`），全部修复，明细见一.13。
其中 3 项为真实缺陷（错字、登录检测无反馈、账号数切换样式回退），其余为交互与信息密度
改进；顺带收敛了三处常量重复与三处原生控件风格分裂。

当前验证：工作区干净；typecheck、lint、129 项测试通过（16 个文件中 15 个执行、1 个 skip，
另有 6 个用例 skip）、production build 全部通过。master 领先 origin 3 个提交（上述三项），尚未推送。

### P2：永久 Dexie migration 测试 — 已完成（2026-09-10）

`tests/dexie.migration.test.ts`（3 用例，fake-indexeddb 真实升级链）已随 CI 运行，
v3→v4 布尔转 `0|1` 契约（含墓碑快照与索引命中）被永久钉死。详见一.12。

### P3：收窄运行时敏感状态 — 已作废（2026-09-10）

Rplay 平台整体移除（`389b007`）后，`rplay_auth_token` 路径不复存在，
token 在 `onInstalled` 时被幂等清除，本项无对象。

### P4：继续拆分 CreatorsView

按 toolbar、grid、list 和 detailed 布局继续拆分。

### P5：单独引入 ESLint — 已完成（2026-09-10）

最小 flat config 上线并接入 CI（`npm run lint`），TS7 经官方双别名与 lint 工具链共存，
首轮 77 错误全修零抑制（含 1 个真回归与 1 个真 bug）。详见一.12。

### P6（待定）：整体 UI 风格重设计

用户 2026-09-10 提出，尚在考虑中，**当前不排期**。

现状：Tailwind 4 + slate 中性配色 + 系统字体栈，卡片式信息流，已有 `.dark` 变体；
UI 面约 26 个组件/视图（dashboard + popup），`assets/main.css` 仅 36 行设计令牌。
用户评价当前风格"也算很不错"，因此动机是风格偏好而非可用性问题。

未决前提：

- 借鉴对象未定（候选方向：X/Twitter 信息流密度、Readwise Reader 阅读工具感、
  Apple HIG 层次、Linear 深色精致感、Pinterest  masonry 杂志感）。
- 范围未定：仅调色板/字体令牌调整，还是组件级重设计。

评估口径（决定时再议）：先只改 `main.css` 设计令牌做低成本试点；
组件级重设计注意与 P4（CreatorsView 拆分）撞车，且本次 P0 未做像素比对，
重设计后建议补一轮视觉确认。

---

## 最终评价

本阶段实现了最初目标的大部分核心价值：

- 关闭凭据安全边界缺口。
- 修复 IndexedDB 静默索引失败。
- 修复自动同步双重断路。
- 阻止随机 ID、碰撞 ID 和 NaN 时间戳污染数据。
- 将字符串错误升级为结构化契约。
- 将关键规则转化为测试和 CI。

追加的抖音阶段在此基础上证明：即使面对无法后台化的平台，项目也能以隔离层 + 不可信输入校验的方式安全接入，而不削弱既有安全边界。

第二批（同日）完成 Rplay 平台卸载、ESLint 与 migration 永久测试三项收官：安全面减少一个
凭据暴露面与一个 content script 注入面，工程面补齐 lint 门禁并把历史 migration 契约钉进 CI。
ESLint 首轮扫描还捕获并修复了一个 UI 真回归（settingsContext 字段缺失）和一个交互真 bug
（刷新按钮双触发）——证明静态检查在缺乏 E2E 的项目里是有效的第三道防线。

项目质量的提升是结构性的，而不是表面增加功能。2026-09-10 的真实 Chrome 使用验证补上最后一块证据缺口后，项目已进入可用状态；~~剩余工作（migration 永久测试、token 姿态、CreatorsView 拆分、ESLint）~~ 中前三项已关闭，剩余工作仅 P4（CreatorsView 拆分）与待定的 P6（UI 重设计），均为非阻塞的打磨项。

第三批（同日）在真实 Chrome 中完成系统性界面走查并修复 14 项发现（3 项真实缺陷、11 项交互
与信息密度改进），同时把账号角色常量与下拉控件各自收敛为单一实现。两点经验值得保留：

- 「日常使用未发现异常」不等于「逐项走查通过」——P0 的日常验证通过后，结构化走查仍产出
  14 项发现，说明两种验证强度不可互相替代（手册 8.2 的检查方式分工）。
- ESLint 与逐项走查在同一批中分别捕获了测试与类型检查都覆盖不到的问题（settingsContext
  字段缺失、刷新按钮双触发、样式回退），关键路径之外的第三道防线实际起了作用。
