# Chorus 项目进步与剩余不足 - 2026-09

> 本文档只留**当前状态与待办**：现状速览 / 二（仍存在的不足）/ 三（成熟度）/ 四（P6–P8）。
> **已关闭条目**的原文见 [docs/archive/2026-09-closures.md](archive/2026-09-closures.md)，
> **第 1–33 批的批次叙述**见 [docs/archive/2026-09-batches.md](archive/2026-09-batches.md)——
> 两者都是**冻结的历史**，不与代码同步，其中的行数、测试计数与提交号只是当时的快照。
>
> **目录**
> - [现状速览](#现状速览截至-2026-09-12) — 只写**现在**是什么状态
> - [二、仍然存在的不足](#二仍然存在的不足) — 只列**仍未关闭**的项
> - [三、当前成熟度判断](#三当前成熟度判断)
> - [四、未来开发方向与待办](#四未来开发方向与待办) — P6（不排期）/ **P7 真机验证清单** /
>   **P8 待办队列（唯一入口）**
>
> 规则与案例：[../AGENTS.md](../AGENTS.md) / [AGENTS_CASES.md](AGENTS_CASES.md)。
> 已做的产品决定：[PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)。

## 现状速览（截至 2026-09-12）

> **接手本项目**：待办入口是[四.P8 队列](#p8交接队列与未来方向唯一待办入口)。
> 本节只描述状态。

**质量门禁（2026-09-12 实测）**

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | `tsc`（TS7 原生）→ `vue-tsc`，含 `strictTemplates`；0 错误 |
| 静态检查 | `npm run lint` | ESLint flat config（**含 `e2e/`**）；0 问题 |
| 回归测试 | `npm test` | 全绿（**具体数字不写死**——它每次提交都变；运行即得） |
| 核心模块覆盖率 | `npm run test:coverage` | per-file branch 阈值：`channelSync` 78 / `postRepository` 75 / `backupRepository` 85（**棘轮**，只能升） |
| 构建 | `npm run build` | `.output/chrome-mv3/` |
| 打包 | `npm run zip` | `chorusdesk-1.0.0-chrome.zip` |
| 真机门禁 | `npm run e2e` | 独立 profile 的完整扩展 E2E，17 项 |

> **门禁数字刻意不写死**：本表此前写「495 通过 / 42 文件」，后来又写「651 / 64」，
> 实际同期已是 555 与 **655 / 66**——`PROJECT_PROGRESS` 因此连续两轮把过期数字交给冷启动
> 的接手者。**能算的不要写死**（见 [AUDIT_2026-09-12.md](AUDIT_2026-09-12.md) §7-2）。

CI（`.github/workflows/ci.yml`）在每次 push/PR 上跑 typecheck + lint + **test:coverage** + build
+ E2E 门禁；打 `vX.Y.Z` 标签触发 `release.yml`（复跑门禁 + 校验标签与版本号一致 + 生成 Release 资源）。

**成熟度**：可作为日常使用的工具，且已由真机反馈驱动了 30 余轮修复（批次叙述见
[批次记录](archive/2026-09-batches.md)）。可靠性主要受**外部平台**
约束（Twitter 网页接口变更、抖音必须真实页面渲染），不取决于本地代码质量。

**当前开放的问题**（逐条证据见[二](#二仍然存在的不足)）

- **数据入口**：备份导入校验**已完成四层**（必填字段 / 字段类型与范围 / settings / 跨表关系）；
  两处刻意偏离（`platform` 不查枚举、时间戳不查单位）记在[队列总表](#p8交接队列与未来方向唯一待办入口)
  的「已证伪 / 不采纳」。
- **状态正确性**：同步入口之间**无协调**——`updateChannel` 没有任何并发锁，
  `platformLastFinished` 是 batch 局部变量。同一频道可被 alarm / 手动 / 深挖 / popup 并发同步，
  **后完成的覆盖前者的 `nextCursor`**（详见[队列总表](#p8交接队列与未来方向唯一待办入口) #2）。
- **数据完整性**：RSS 的 `guid` 只在 feed 内唯一却当全局主键（#3）、媒体缓存文件名截取
  postId 前 16 位（#13）、`PROXY_IMAGE` 无 byte/MIME 上限（#8）。
- **能力错配**：Twitter 不支持 SW 而 autoSync 不筛（#6）、取消信号是 caller/timeout 二选一（#7）、
  聚合层丢弃 batch 结果（10/10 失败仍记「完成」，#9）。
- **规模**：每次 reload 全库 `toArray` 进 Vue 内存且**先**全库跑 `healBrokenPostMedia`（#5 / #10）。
- **失败语义**：`FetchError` 的 HTTP/解析/schema/timeout 细分仍未做，401/403 未专门归类（#12）。
- **证据缺口**：真实载荷 fixture 只覆盖 4 个平台（bilibili / douyin / rss / xiaohongshu）；
  weibo / pixiv / fantia 三个适配器连解析测试都没有（二.3）。
- **无测试的活模块**：`declarativeNetRequest.ts`（186 行，全部防盗链规则）零测试引用（二.3）。
- **债务台账**：规则 8 的 `entrypoints → infrastructure/db` 直连仍有 8 处（二.4）。
- **外部依赖风险**（本地重构无法消除）：Twitter/X 路径先天脆弱（二.6）、抖音 DOM 耦合（二.7）。
- **待真机确认**：见[四.P7](#p7真实浏览器行为验证滚动清单) —— RSS 阅读视图、抖音重试期限、
  图片代理 403 冷却。
- **未排期**：四.P6 整体 UI 风格重设计。
- **已否决（不要重新提出）**：PR-first 工作流、待办迁 GitHub Issues——个人仓库不引入
  协作开销（[PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)）。

**已决的非目标（不要再提议）**

见 [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)：RSS 卡片不显示配图；视频缩略图不加角标/
播放图标（页脚「视频动态」已是静态标识）。

**验证方法上的硬约束**

- 真实浏览器验证**只开独立 profile 的专用实例**，绝不驱动用户正在浏览的窗口（规则 25）。
- **完整扩展 E2E 可用**：`--load-extension` 已被 Chrome 忽略，但
  `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` 可以加载构建产物，
  并在扩展自己的 Service Worker / 页面里取证（存储、alarm、消息、真实点击与文件导入）。
  见规则 28 与[四.P7 补记](#p7-补记独立-profile-的全扩展-e2e2026-09-11)。
- 该 E2E **不跨浏览器重启留存**（重启后重新加载等于全新安装），故跨重启行为仍需真实安装验证。
- 组件级布局验证走单文件 HTML 打包（规则 30），jsdom 不做布局。

---

## 二、仍然存在的不足

> **只列仍未关闭的项。** 已关闭条目的原文（含「原记录：…」留存）见
> [archive/2026-09-closures.md](archive/2026-09-closures.md)。

### 1. 备份校验 — 已完成（2026-09-12）

`parseBackup` 已做四层校验（必填字段 → 字段类型/范围 → settings → 跨表关系），
细节、两处刻意偏离与验收证据见[队列总表](#p8交接队列与未来方向唯一待办入口)的「已完成（本轮）」。
本节不再保留原文，避免两处各记一份。

### 2. `FetchError` 分类仍可提高精度

部分 adapter 使用宽范围 `try/catch`：

- JSON/XML parse error 可能归类为 network。
- 未特殊处理的 401/403 可能归类为 network。
- 平台返回格式变化可能没有归类为 parse。

已解决的一半：写库失败不再冒充 `network`（新增 `storage` code，`isStorageFailure` 判定，
`channelSync` 与 `batchSync` 共用；**错误码驱动平台冷却**，所以这不只是文案问题）；
多源适配器（bilibili 等）在主源失败但仍有内容时返回 `degraded: true` + `warnings`，
由 `channelSync` 记 warn 日志，「安静地少数据」因此可被看见。

**剩余**：按 HTTP / 解析 / schema / timeout / transport 五阶段分别分类，以及 401/403 专门归类。

> **不要**通过复活 `FetchError.retryable` 来做这件事——该字段已于 2026-09-12 删除：
> 全仓无读取方，行为一直由 `code` 决定；且「按可重试性重试」与规则 19 的冷却机制直接冲突
> （检测到限流后继续猛打比不检测更糟），当时也无实测收益数据支撑。要按阶段重试应重新设计。

### 3. 平台模块的测试覆盖不均

**真实载荷 fixture 只有 4 个平台**：bilibili / douyin / rss / xiaohongshu（`tests/fixtures/`）。

| 平台 | 直接 import adapter 的测试 | 真实 fixture |
|---|---|---|
| douyin | 9 个文件（含 `collector` / `contract` / `tabLifecycle` / `deepcollector`） | 有 |
| bilibili | `bilibili.parse.test.ts` | 有 |
| xiaohongshu | `parse` + `enrich` | 有 |
| rss | `parse` + `content`（`repair` 测的是存量行谓词，不 import adapter） | 有 |
| twitter | `emptyTimeline` + `twitterTimeline.injected` | **无**（payload 由 `tweetEntry()` 手工构造） |
| youtube | `youtube.handle.test.ts` | 无（有意不补 RSS 映射） |
| weibo / pixiv / fantia | **无** | 无 |

**最高优先是 Twitter 的真实 payload**：它的现有 fixture 是手工构造的，而该 helper 的历史版本
**把 bug 编码了进去**（嵌套多一层，正好匹配解析器当时读的位置，见规则 15/21）——
即现有 fixture 只能证明「解析器与自己一致」。

**另一类缺口：活模块无自动化验证**（既无测试直接 import，也无任何测试经由其它路径触达）：

| 模块 | 行数 | 说明 |
|---|---|---|
| `src/infrastructure/chrome/declarativeNetRequest.ts` | 186 | 6 条防盗链规则（id 1001–1006），**已由真机确认命中**（四.P7）但无自动化验证 |
| `src/infrastructure/chrome/autoSync.ts` | 99 | alarm 自动同步；端到端行为由 `e2e/release-gate.mjs` 的 4 个 alarm 步骤覆盖，无单元级判据 |
| `src/infrastructure/chrome/platformAuth.ts` | 66 | 登录指示灯判据（cookie 名表），**它正是三个 adapter `checkAuthStatus` 被删后剩下的唯一真相源** |
| `src/infrastructure/chrome/optionalHostAccess.ts` | 51 | RSS 按站点授权；真实弹窗行为只能真机观察，但授权判定本身可直测 |
| `src/sync/cursorState.ts` | 90 | `__END__` 语义唯一实现——**经消费点间接覆盖**，见下 |

> `cursorState.ts` 是**间接覆盖**而非无人守护：它的两个消费点各有回归套件
> （`douyin.endcursor.test.ts` / `douyin.loophead.test.ts`，4 例），改错会同时打红两套。
> 这正是当初把它抽成独立模块时验证过的性质（变异：清空 `SINGLE_SHOT_ACQUISITION`
> 会让两个套件同时失败）。
>
> `src/application/*`（含 `postService` 109 行）**不在此表**：它们经 barrel
> `../src/application` 被测试引用，grep 模块名会误判为「无测试」——这与规则/评审里
> 记录过的 `tco.ts` 同类陷阱（测试寄生在别的文件名下）。

**有意不补的**（记录以避免被当成疏漏）：`youtube.ts` 的 RSS 映射、`douyin` 的注入时序细节
（只能真机观察）。见 [DEVELOPMENT.md](DEVELOPMENT.md) §10。

### 4. 规则 8 的直连台账仍有 8 处

`entrypoints/ → src/infrastructure/db/*` 的直接 import，当前 **8 处使用**（不是 8 个文件，
`import type` 不计）：

| 文件 | 用到什么 |
|---|---|
| `dashboard/composables/useDashboardShell.ts` | `db`、`settingsRepository`、`statsService`、`healBrokenPostMedia` |
| `dashboard/composables/useFeedFilters.ts` | `settingsRepository` |
| `dashboard/composables/useMediaMaintenance.ts` | `healBrokenPostMedia`、`cleanupOldPosts` |
| `popup/composables/useQuickFollow.ts` | `db` |

**口径**：优先加 service 方法，而不是新增直连 import；新增时**同一提交内**把文件加进
`AGENTS.md` 规则 8 的表。上一轮漂移的原因就是「一处」没有定义——现在定义为「使用次数」。

### 5. 新增平台仍涉及多个配置点

新增平台需要同步修改 adapter、registry、platform metadata、URL parser 与 cookie auth。
（域名这一侧已收敛：`PLATFORM_HOSTS` 是唯一来源，manifest 由其**派生**，代理白名单与
Referer 同样读它，见 AGENTS 规则 2；占位名前缀也已改为从 `urlParser.GENERATED_NAME_PREFIXES`
单一来源派生 + 双向守卫测试，见规则 9。）

未来出现**真实**新增平台需求时，可评估统一的 `PlatformDefinition`；
**当前不应为预想需求提前增加复杂抽象**。

### 6. Twitter/X 路径先天脆弱（外部依赖）

该路径依赖网页客户端常量、未公开 GraphQL operation ID、用户页面会话和非公开响应结构。

潜在影响：服务端 operation ID 或响应 shape 变化、页面 CSP 或上下文变化、
平台风控。**无法仅靠本地重构消除。**

> 已修复的一处**本地**缺陷（2026-09-11）：注入函数引用了模块作用域的 bearer 常量，
> 而 `chrome.scripting` 会 `toString()` 序列化函数——页面里直接 `ReferenceError`，
> 被它自己的 `try/catch` 吞成普通失败。**该路径在生产中一次都没跑成功过**，
> 每次都静默落到直连兜底。现常量经 `args` 传入，并由
> `tests/twitterTimeline.injected.test.ts` 求值**函数源码**（无闭包）钉住。

### 7. 抖音路径的固有约束（外部依赖）

- **同步前置条件**：**无**。第十一批起，若一个抖音页面都没有，扩展会自行开一个后台标签页
  并在采集后关闭。报错文案此前写成「请打开该创作者主页」，夸大了要求，已更正。
- **DOM 结构耦合**：页面改版（滚动容器类名、网格节点、封面/标题选择器变化）会直接破坏
  采集器，且只能在真实页面中发现——fixtures 无法预警。
- **短缺不等于被截断**：主页标示的作品数**包含作者隐藏的作品**，所以「加载数 < 标示数」
  是常态，不能据此断言「未登录被截断」。早期文档把一次「18 / 29」的实测当作截断证据，
  该推断**已撤回**（规则 10）。采集器的应对是保持可续挖、绝不写「已到底」——证据不足时
  宣称到底会永久封死更早的作品，而多发一次滚动只多花一次请求。
- **capability 边界**：与 Twitter 路径同属「借真实页面绕过反爬」的方案，
  风控升级或页面架构变化都可能使其失效。

### 8. 同步入口之间没有协调（状态正确性，2026-09-12 核实）

**最严重的一条**，因为它写错数据且**用户看不见**。

`updateChannel` 不在任何并发锁下运行（`grep inFlight|lock|mutex src/sync/` 为空），
`status: 'updating'` 只是写入的字段、不是互斥。而能进入它的入口有五个：
Dashboard 全部刷新 / 创作者 / 单频道、深挖历史、popup 首次抓取、alarm 自动同步。

于是同一频道可被并发同步，各自持有不同时刻的 Channel 快照，**后完成的覆盖前者**：

- `nextCursor` 被旧任务覆盖 → **深挖历史回退或跳段，无任何日志区分**；
- `lastSuccessAt` / `status` 错乱 → 同步徽章说谎；
- `platformLastFinished` 是 batch 局部变量（`batchSync.ts:83/167`）→
  **跨入口并发时规则 19 的平台节流下限整体失效**（「检测到限流还继续打」）。

这不是「偶发」，是结构上必然、只差一次时序巧合。修法见队列 #2。

### 9. 身份边界没桥接（数据完整性）

- **RSS**：`rss_${stableHash(guid)}`（`rss.ts:199`），而 `guid` 只保证 **feed 内**唯一。
  但 `Post.id` 与 `PostSuppression.postId` 都是**全库主键**。两个 feed 各发
  `<guid>1</guid>` → 同一篇内容；更糟的是在 A 上「彻底删除」会**顺带压制 B**。
  这不是「也许碰撞」，是两层 scope 没对齐。
- **媒体缓存**：目录是 `creatorName/platform/YYYYMMDD_postId前16位`
  （`pathResolver.ts`），而内存 object URL 用 `postId_mediaIndex`。
  三个 identity 互不相同：**创作者改名即失联**（缓存还在、找不到），
  且**已经有稳定完整主键却截成 16 位**做文件名。

### 10. 平台能力没有模型（能力错配）

各模块单独看都对，组合起来互相否定：

- `twitter.ts:137` 明确 `IS_SERVICE_WORKER → unsupported`，而 `autoSync.ts:50`
  `db.channels.toArray()` **不筛平台**——开了自动同步，Twitter 必然报不支持；
- popup 首次抓取为了「关窗不中断」改走 `SYNC_CHANNEL` → SW（对），
  但新关注的 Twitter 频道因此**必然**撞上同一条 unsupported；
- `channelSync.ts:248` 的 `signal: options?.signal ?? abortController.signal` 是**二选一**：
  caller 传了 signal，45s 超时就不再拥有取消权，底层请求继续跑；
- `autoSync` 丢弃 batch 结果：**10 个频道全失败也记「后台自动同步完成」**。

修法见队列 #6 / #7 / #9。

### 11. 数据访问是全量内存模型（规模）

`useDashboardData` 每次 reload：`healBrokenPostMedia()` → `creators.toArray()` →
`channels.toArray()` → `posts.orderBy(...).toArray()`，全部进 Vue 响应式；
筛选在内存里全表扫，`useWaterfallFeed` 的 `slice(0,36)` 只是 **DOM 分页，不是数据分页**。

与「深挖历史」这个功能**天然矛盾**：存得越成功，首页 reload 越贵。
且 `healBrokenPostMedia`（迁移/维护职责）被放在 **hot path**，每次读取都全库跑一遍。

修法见队列 #5（便宜的先行）/ #10（真重构）。

### 12. 工程质量项（不直接致错，抬高出错概率）

- **E2E 一个 click 卡死一整串**：`backup.export` 失败 → backup 4 步 + alarm 4 步全 skip。
  实测偶发约 4 次跑挂 1 次，**两次 CI 红灯都是它**。
- **`PROXY_IMAGE` 无大小/MIME 上限**（`arrayBuffer()` 后直接 base64），
  而它现在允许任意 http(s) 主机（为 RSS 图片）——这是合理的产品行为，但没有 byte ceiling。
- **`toSecureMediaUrl` 仍用 `includes()`** 判小红书域名（`media.ts:27-29`），
  与规则 1 的主机名纪律不一致（此处不决定凭据，故严重度低，但属双轨）。
- **DNR 186 行零测试**，且 `removeRuleIds` / `addRules` 两处手维护规则 id。
- **无 MessageMap**：改一条消息要同步「五件套」，靠文档提醒。
- **新增平台 8–10 个散点**；`PLATFORM_REGISTRY` 不是 `Record<KnownPlatform, …>`。
- **release.yml 跑 `npm test` 而 CI 跑 `test:coverage`**，注释却写「Same gates as CI」。

---

## 三、当前成熟度判断

### 本阶段之前

> 功能覆盖较广的个人扩展；核心功能可用，但安全和数据一致性依赖隐含假设，缺少持续验证。

### 本阶段之后

> 具备明确安全边界、稳定数据契约、可解释同步路径、基本查询性能治理和持续集成的可维护扩展项目。

### 尚未达到

> 具备完整真实浏览器 E2E、权限最小化、完整 schema、统一平台描述、成熟可观测性和稳定外部 API 策略的发布级产品。

**2026-09-12 的第三次评估（[AUDIT_2026-09-12.md](AUDIT_2026-09-12.md)）下调了结论**，其判断是：
**防御体系超前于领域模型与治理体系**——反事故的机制（规则、E2E、覆盖率棘轮）很成熟，
但「数据库允许存在哪些状态」这一层没有对等的证明手段。该判断的直接产物是删除域重做
（已完成，见 [`DELETION_MODEL.md`](DELETION_MODEL.md)）。

---

## 四、未来开发方向与待办

### 方向总览（按「值不值得做」排序，不是按工作量）

本项目的成熟度瓶颈**不在代码结构**（分层、门禁、覆盖率棘轮都够用了），而在下面五层，
按「错了会怎样」排序。**完整清单（25 项，含证据与批次建议）在
[四.P8 队列总表](#p8交接队列与未来方向唯一待办入口)**，本节只说方向。

| 层 | 现在的缺口 | 为什么排这个位置 |
|---|---|---|
| **1. 状态正确性** | 同步入口之间没有协调：`updateChannel` 无任何并发锁，`platformLastFinished` 是 batch 局部变量。同频道可被 alarm / 手动 / 深挖 / popup 同时同步，**后完成的覆盖前者的 `nextCursor`**——写错数据且**用户看不见** | 会静默写错状态，且没有任何观测手段能发现 |
| **2. 数据完整性** | 备份校验已完成；剩余是 RSS 的 `guid` 只在 feed 内唯一却当全局主键（删除 A 可能顺带压制 B），媒体缓存的文件名截取 postId 前 16 位 | 会静默损坏或丢失用户数据 |
| **3. 能力错配** | 模块各自"设计正确"却组合起来互相否定：Twitter 明确不支持 SW，autoSync 不筛；popup 首次抓取也走 SW。取消信号 caller ∪ deadline 是二选一。聚合层把 batch 结果丢掉（10/10 失败也记"完成"） | 功能时好时坏，表现为"平台抽风" |
| **4. 规模与性能** | 每次 reload 全库 `toArray` 进 Vue 内存（只显示 36 条），且**先**全库跑一遍 `healBrokenPostMedia` | 每次都付税，随历史增长恶化 |
| **5. 工程质量** | E2E 一个 click 让 backup+alarm 全 skip；无 MessageMap；DNR 零测试且两处手维护；新增平台 8–10 个散点 | 不直接致错，但抬高下一处缺陷的概率 |

**明确不做**：整体 UI 风格重设计（P6，用户不排期）、PR-first 工作流、待办迁 Issues
（个人仓库不引入协作开销）、往微交互追加工程资源（AUDIT P3 冻结）。

### P6：整体 UI 风格重设计 — 不排期

用户 2026-09-10 提出，**当前不排期**（2026-09-11 明确）。

现状：Tailwind 4 + slate 中性配色 + 系统字体栈，卡片式信息流，已有 `.dark` 变体；
UI 面约 26 个组件/视图，`assets/main.css` 仅 36 行设计令牌。用户评价当前风格「也算很不错」，
因此动机是风格偏好而非可用性问题。

未决前提：借鉴对象未定；范围未定（仅调色板/字体令牌，还是组件级重设计）。
评估口径（决定时再议）：先只改 `main.css` 设计令牌做低成本试点；组件级重设计需补一轮
视觉确认（`e2e/creators-render.mjs` 与 `feed-render.mjs` 已有逐字节对比能力）。

> 与 [AUDIT P3](AUDIT_2026-09-12.md) 一致：**冻结**「往微交互继续投工程资源」（侧栏、排序、
> 动画的**新增**）。已做的不是错，是机会成本。**不等于禁止打磨 UI**——设计语言/系统化
> （如原生 `alert/confirm` → 自有 Dialog）属该做的一层。

### P7：真实浏览器行为验证（滚动清单）

以下项**只在编译与测试层验证过**，正确性取决于真实浏览器语义，需要人工确认。

**已通过（勿重复探测）**

- ✅ `declarativeNetRequestWithHostAccess` 仍命中防盗链规则（微博 / 小红书图片正常加载）。
- ✅ RSS 站点授权弹窗按站点生效，且非平台域名 `凭据：omit`。
- ✅ 开发者日志面板（筛选、详细模式、跨上下文可见）已在日常排查中使用。
- ✅ 抖音临时页自动关闭，且不扰动用户已打开的标签页。
- ✅ **移除 `tabs` 后 `tabs.query` 仍能读平台标签页 URL**（原「风险最高」项，
  2026-09-11 在该扩展自己的 Service Worker 内实测）：平台域名可读、无 host 权限的域名
  `undefined`；抖音 / Twitter 的标签页定位与 `platformAuth` 的 Twitter 兜底均不受影响。
  > 附带事实：**扩展自己的页面 URL 也读不到**。现有代码不读自身页面 URL（Popup 探测读的是
  > 活动标签页，由 `activeTab` 覆盖），故无影响；若将来要读，需重新评估。
- ✅ 「展开全文」的溢出门控与阅读视图（注入探针实测 `clientHeight 78 / scrollHeight 332`
  → 按钮出现；6 字卡片 `20/20` → 不出现；`role="dialog"` + Escape + 滚动锁恢复）。
- ✅ 反复打开 popup **不**重置 alarm 倒计时（`scheduledTime` 四次读数 Δ 0 ms）。
- ✅ 备份导出→删库→导入的完整往返（同 profile 内）。
- ✅ Twitter 标签页路径**在生产中真正跑通**（2026-09-12 真机日志：四个渠道全部走标签页路径、
  全部成功，且都复用已打开的 x.com 标签页）。这同时证明 `PLATFORMS.md` §2.2 那条建议
  现在成立——在该路径修好之前它做不到。
- ✅ 抖音同步不再触发风控（本轮失败的两个频道全部成功，`平台原始 10 条`；
  `作品网格在等待时间内未渲染` 与 `Frame with ID 0 was removed` 均 0 次；两次请求间隔实测 15.5s）。

**待确认**

1. **RSS 卡片与阅读视图**：根因链已全部定位并修复（`content:encoded` → `content` → `description`
   回退取值；上限 4000 → 20000；新增 `Post.contentHtml` + `.article-body` 标签级排版；
   图片代理不再拒绝非平台域名）。已在本地用真实源 + 构建产物渲染复核，**待真机目视确认**。
   （卡片是否显示配图已按用户决定**不再跟踪**，见 [PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)。）
2. **抖音采集的重试期限**：真因是「按次数限制重试是错的」——探针在冷标签页上会持续
   「注入未返回结果」（每次约 1s），3 次上限 = 1.6s 就放弃，而被等待的页面**约 10s 才水合**。
   已改为 **20s 时间期限**。待确认：重载后相关频道是否恢复正常；日志中
   `网格探针未能完成，重试` 出现多次后**采集成功**，即为本修复在起作用。
3. **图片代理 403 的冷却有效性**：`assets.juya.uk` 仍可能返回 403（CDN 侧 183/183 均为 200，
   故与抓取风控同源）。冷却机制生效后再观察。

**长期项**：alarm 跨浏览器重启的长期行为（见 [四.P8 仍不可验](#仍不可验环境限制别浪费时间重试)）。

### P7 补记：独立 profile 的全扩展 E2E（2026-09-11）

`--load-extension` 在 Chrome 152 被忽略之后，项目一直把「完整扩展 E2E 不可用」当作既定天花板。
`--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` 推翻了其中一半：
可以完整加载构建产物，并能在该扩展自己的 Service Worker 与页面里取证。规则 28 已按实测改写。

由此完成的三项验证（均为真实构建产物、独立 profile、测毕删除）：

| 待验项 | 方法 | 结果 |
|---|---|---|
| 备份导出产生真实文件 | 设下载目录后点「下载 JSON 备份」 | `creator-feed-hub-backup-*.json`，1204 B，四个 section 齐全 |
| 备份导入还原数据 | 先删三张表的探针行，再用 `DOM.setFileInputFiles` 交回导出文件 | 创作者/频道/动态全部还原，正文与收藏位保持 |
| **打开 popup 不重置 alarm** | 连开 3 次 popup，前后各读 `alarms.getAll()` | 4 次 `scheduledTime` 完全一致（Δ 0 ms） |

**仍不可验的具体原因**（而非笼统的「无法验证」）：`Extensions.loadUnpacked` 加载的扩展
**不跨浏览器重启留存**——重启后重新加载等同于一次全新安装，alarm 是否存在、
`onInstalled` 何时触发都被重建而非延续。

**一处 harness 陷阱**：导入成功路径调用 `alert()`，它会阻塞渲染进程主线程，
连带令 `Runtime.evaluate` 与 `Page.enable` 永久挂起（表现为「页面卡死」而非产品缺陷）。
须在执行动作**之前**启用 Page 域并应答 `Page.javascriptDialogOpening`。

### P8：交接队列与未来方向（唯一待办入口）

> 本节是**唯一**的待办入口。历史文档（archive、AUDIT、REVIEW）不承接新待办。
> **动词就是全部授权**（规则 32）：队列是清单，不是「下次任何会话可以直接开写」的许可；
> 带用户确认关的条目，关没过就是没过。

#### 交接基线（接手前先核对）

- **代码基线**：`master`，工作区干净，与 `origin/master` 同步。接手第一件事：`git status -sb`
  与 `git log -1 --oneline`（此处**不写提交哈希**——它每次提交都变，写死即过期）。
- **门禁全绿**：`npm run typecheck`、`npm run lint`、`npm test`、`npm run test:coverage`、
  `npm run build`、`npm run e2e`。**具体测试数不写死**（运行即得）。
- **读序**：`AGENTS.md`（33 条规则 + Non-goals，**必读**）→ `docs/ARCHITECTURE.md`（当前事实
  与契约）→ 本文件「现状速览」→ 本节。`docs/DEVELOPMENT.md` 是改动流程手册。
- **历史材料**：`docs/DOUYIN_RESEARCH_2026-09.md`（抖音为何不能走 API）、
  `docs/DELETION_MODEL.md`（删除域语义与不变量）、`docs/PUBLISHING.md`（上架材料，草案）、
  `docs/REVIEW_2026-09.md`（可维护性审计）、`docs/AUDIT_2026-09-12.md`（批判式审计）。

#### 不要重做的验证（已通过，勿重复探测）

见[四.P7](#p7真实浏览器行为验证滚动清单)及补记，其中已在**真实宿主**中确认的：
`tabs.query` 无 `tabs` 权限仍可读平台标签页 URL；备份导出→删库→导入的完整往返（同 profile）；
反复打开 popup **不**重置 alarm；`declarativeNetRequestWithHostAccess` 仍命中防盗链；
「展开全文」的溢出门控与阅读视图；抖音临时页自动关闭且不扰动用户已开标签页；
Twitter 标签页路径真的跑通了。

#### 队列总表（唯一待办入口）

来源：**第一轮审计**（`AUDIT_2026-09-12.md`，P0–P3）、**可维护性评审**（`REVIEW_2026-09.md`）、
**第二轮批判性审查**（2026-09-12 晚，逐条回代码核实）、以及历次会话发现。
**每一行都验证过**；核不实的断言已剔除，见文末「已证伪 / 不采纳」。

**排序原则**（第二轮审查修正后的口径）：

1. **状态正确性** → 会写错数据、且用户**看不见**的（并发覆盖 cursor、身份越界）
2. **数据完整性** → 会静默损坏或丢失用户的（校验、孤儿引用）
3. **能力错配** → 模块各自"设计正确"但组合起来互相否定的（Twitter 后台同步）
4. **规模与性能** → 每次都付的税（全库加载、hot-path 修复）
5. **工程质量** → 降低下一处缺陷的概率（协议类型化、平台单一来源、E2E 拆分）

| # | 事项 | 类别 | 证据 |
|---|---|---|---|
| **1** | ~~**`restore-all` 语义越界**~~ **已完成 2026-09-12** | 状态正确性 | 见下 |
| **2** | **SyncCoordinator**：同频道 single-flight + 跨入口平台节流 | 状态正确性 | 无任何并发锁；`platformLastFinished` 是 batch 局部变量 |
| **3** | **RSS identity scope**：`guid` 只在 feed 内唯一，却当全局主键 | 数据完整性 | `rss.ts:199` |
| **4** | **单条/批量恢复共享同一策略** | 数据完整性 | 已完成，见 1 |
| **5** | **`healBrokenPostMedia` 移出 reload hot path** | 规模 | `useDashboardData.ts:58` 每次 reload 全库扫 |
| **6** | **Platform capability 模型**：`backgroundSync` / `pageContextRequired` / `cancellable` / `history` | 能力错配 | 无 capability；Twitter 到 SW 才说「不支持」 |
| **7** | **取消信号可组合**：caller signal ∪ deadline | 能力错配 | `channelSync.ts:248` 的 `??` 二选一 |
| **8** | **`PROXY_IMAGE` 加 byte/MIME 上限** | 数据完整性 | 只有 `arrayBuffer()`，无上限 |
| **9** | **后端聚合诚实**：autoSync 把结果丢了 | 能力错配 | 10/10 失败也记「完成」 |
| **10** | **Feed 数据分页**（IndexedDB query 取代全量 `toArray`） | 规模 | 全库进 Vue 内存，只显示 36 条 |
| **11** | **E2E 拆独立 scenario** | 工程质量 | 一个 click 让 backup+alarm 全 skip |
| **12** | **`FetchError` 五阶段细分** | 数据完整性 | 本轮 A2，未做 |
| **13** | **媒体缓存 identity**：目录用 creatorName、文件用 postId 前 16 位 | 数据完整性 | 改名即失联；主键被截短 |
| **14** | **DNR 规则表驱动 + 测试** | 工程质量 | 186 行零测试；remove/add 两处手维护 |
| **15** | **`toSecureMediaUrl` 的 `includes()` → `hostMatches`** | 数据完整性 | `media.ts:27-29` |
| **16** | **MessageMap 类型协议** | 工程质量 | 完全没有；改一条消息要同步 5 处 |
| **17** | **Platform 声明性事实单一来源** | 工程质量 | 新增平台仍 8–10 个散点 |
| **18** | **Twitter 真实 payload fixture** | 证据 | 手工 fixture 曾把 bug 编码进去 |
| **19** | **weibo / pixiv / fantia 解析测试** | 证据 | 零直接测试 |
| **20** | **`autoSync` / `platformAuth` 单元测试** | 证据 | 零测试 |
| **21** | **规则 8 台账收敛** | 工程质量 | 8 处直连 |
| **22** | **`AGENTS.md` 规则 9/28/30 压到 ≤8 行** | 工程质量 | 51/51/55 行 |
| **23** | **`dashboardToolbar` 偶发未处理拒绝** | 工程质量 | ~1/8 次 |
| **24** | **release.yml 与 CI 门禁一致性** | 工程质量 | Release 跑 `npm test`，CI 跑 `test:coverage` |
| **25** | **平台适配器接口里的 Twitter 私有方法** | 工程质量 | `parseGraphQLResult?` / `fetchAjaxFallback?` |

**批次建议**（每批独立可交付、可验证）：

- **批次 1（状态正确性）**：#2 SyncCoordinator + #3 RSS identity + #7 取消信号。
  三者都是"同一次操作在不同时序/不同入口下结果不同"，一起做才不会出现三套补丁。
- **批次 2（规模）**：#5 hot-path 修复（便宜，先做）+ #9 聚合诚实。
- **批次 3（能力模型）**：#6 capability + #8 proxy 上限。
- **批次 4（工程质量）**：#11 E2E 拆分（CI 可信度是它自己的产品）+ #24 release 一致性。
- **批次 5（证据）**：#18/#19/#20。
- **长期**：#10 分页重构、#16 MessageMap、#17 平台单一来源、#13 缓存 identity。

---

#### 已完成（本轮）

**#1 `restore-all` 语义越界 + #4 单条/批量共享策略** —— **已完成（2026-09-12）**。

**问题**（第二轮审查指出，回代码核实属实）：

```ts
await db.postSuppressions.clear();   // 无条件
```

站在回收站里按「全部恢复」，会把**回收站之外**的 `彻底删除` 记录一并解封——而界面
对「彻底删除」的承诺是「今后同步也不会再出现」。审查的原话最准确：
**「彻底删除」实际是「暂时永久，直到你以后点另一个按钮」。**

**同一处还有单条/批量不对称**：单条恢复校验父 Channel（`postRepository.ts:91`），
批量不查，直接 `bulkPut`。v6 迁移会把旧 `deletedPostIds` 的孤儿墓碑搬进 `recycleSnapshots`，
于是**同一条记录，单条恢复拒绝、批量恢复接受**。

**改法**（用户 2026-09-12 拍板选方案 1「拆两个」）：

- 抽出 `isOrphanSnapshot()`，**单条与批量共用**——不对称本身就是缺陷。
- `restoreAllDeletedPostIds()` 只动快照：恢复 `postData`、只解除**回收站里这些 id** 的
  抑制、返回 `{ restored, dropped }`（孤儿计数**上报**而不是静默写回）。
- 新增 `releaseAllSuppressions()` + `countPermanentlyDeleted()`：解除**所有**抑制是
  一个**独立命名**的动作，确认框写明「其中 N 条已经彻底删除过，解除后可能重新出现」。
- UI：回收站内按钮改为「恢复回收站全部动态」，旁边一个更弱的「解除所有删除状态」。

**验证**：4 例跨操作**序列**测试（不是单操作不变量）。两处变异各自被抓住：

- 把 `bulkDelete(ids)` 改回 `clear()` → `restoring the bin does NOT revive an earlier 彻底删除` 失败；
- 去掉批量路径的孤儿检查 → 两个孤儿用例失败。

**为什么原测试没抓到**（审查的判断正确）：原来 12 个不变量测试是**一条不变量一个 API**，
逐条全绿，而缺陷从不在单个操作里——是**后续操作悄悄改写了先前操作的结果**。
批次 1 起，删除域新增测试一律按"操作序列 → 最终状态"写。

---

#### 已证伪 / 不采纳（不要让下一轮再提）

- **「当前 master 不是全绿，所以不能再写所有门禁通过」**——措辞不准。准确说法：
  **HEAD 的红灯是真实状态**（以 `gh run list` 为准），但红因指向 E2E 输入注入 flake，
  不是业务代码回归。两次红都发生在**纯文档提交**上（`c7126c7`、`5530eba` 后的那两次）。
  门禁不可靠这件事本身已进队列（#11）。
- **「restore-all 是没人注意的实现遗漏」**——不准确。它是 `DELETION_MODEL.md` 第 48 行
  **用户已确认的语义**（「全部恢复 → suppression 全部删除」）。真正的性质是
  **既定语义与「彻底删除」的界面承诺冲突**，所以解法是拆动作、不是改语义。
- **平台 `platform` 字段做枚举校验**——会让平台移除前导出的备份全部无法导入，见 A1。
- **PR-first 工作流 / 待办迁 GitHub Issues**——`PRODUCT_DECISIONS.md`，个人仓库不引入协作开销。

---

#### 仍不可验（环境限制，别浪费时间重试）

- **alarm 跨浏览器重启的长期行为**：CDP `loadUnpacked` 加载的扩展不跨重启留存，
  重启后重新加载等同全新安装。要验只能在真实安装的扩展上做。
- **Twitter / 抖音路径的固有脆弱性**（二.6 / 二.7）：属外部依赖，本地重构无法消除。
- **`healBrokenPostMedia` 的真实收益**：本地无大库，无法测量它在大历史下的实际代价（#5）。

#### 已知陷阱（踩过，省你时间）

- 扩展 E2E 必须带 `--enable-unsafe-extension-debugging`，否则 `Extensions.loadUnpacked`
  报 `Method not available`（规则 28）。
- **E2E 偶发 `click=0`**：输入未送达，约 4 次跑挂 1 次；两次 CI 红灯都是它。
  失败信息**自带归因**（"this is the environment, not the view under test"）——那正是
  没人继续查的原因，别被它锚定（#11）。
- 导入成功路径的 `alert()` **阻塞渲染进程**，连带 `Runtime.evaluate` / `Page.enable` 永久挂起；
  须在执行动作前启用 Page 域并应答 `Page.javascriptDialogOpening`。
- 视觉验证只开独立 profile 的专用实例，绝不驱动用户正在浏览的窗口（规则 25）。
  **`--window-position=-2400,-2400` 不够**——窗口仍会出现在任务栏，要**最小化**（规则 28）。
- jsdom 不做布局：几何问题用规则 30 的单文件 HTML 打包在真实排版引擎里量。
- 脚本化改写必须断言命中数，否则「匹配不到」会产出假绿（规则 26）。
- 本仓库 `core.autocrlf=true`：签入为 LF，工作区可能是 CRLF，多行锚点会匹配不到。
- **代理派活**：穷尽式核查用 `reviewer` / `task`，**不是** `scout`；多代理写同一文件必须先
  经 `hub` 协调边界（规则 31，含 2026-09-12 的复发案例）。
