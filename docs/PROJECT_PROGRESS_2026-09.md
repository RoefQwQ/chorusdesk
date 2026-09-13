# Chorus 项目进步与剩余不足 - 2026-09

> 本文档只留**当前状态与待办**：现状速览 / 二（仍存在的不足）/ 三（成熟度）/ 四（P6–P8）。
> **已关闭条目**的原文见 [docs/archive/2026-09-closures.md](archive/2026-09-closures.md)，
> **第 1–33 批的批次叙述**见 [docs/archive/2026-09-batches.md](archive/2026-09-batches.md)——
> 两者都是**冻结的历史**，不与代码同步，其中的行数、测试计数与提交号只是当时的快照。
>
> **目录**
> - [现状速览](#现状速览截至-2026-09-14) — 只写**现在**是什么状态
> - [二、仍然存在的不足](#二仍然存在的不足) — 只列**仍未关闭**的项
> - [三、当前成熟度判断](#三当前成熟度判断)
> - [四、未来开发方向与待办](#四未来开发方向与待办) — P6（不排期）/ **P7 真机验证清单** /
>   **P8 待办队列（唯一入口）**
>
> 规则与案例：[../AGENTS.md](../AGENTS.md) / [AGENTS_CASES.md](AGENTS_CASES.md)。
> 已做的产品决定：[PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)。

## 现状速览（截至 2026-09-14）

> **接手本项目**：待办入口是[四.P8 队列](#p8交接队列与未来方向唯一待办入口)。
> 本节只描述状态。
>
> **未提交**：批次 8（2026-09-14，三个适配器缺陷 + 媒体卡片几何）与批次 9（同日的
> fantia 正文取错来源 + 空媒体）改动都在工作区里，
> 见[四.P8 基线](#交接基线接手前先核对)。

**质量门禁（2026-09-14 实测）**

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
- **已否决（不要重新提出）**：PR-first 工作流、待办迁 GitHub Issues——单人维护的项目
  不引入协作开销（[PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)）。

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

### 2. `FetchError` 分类仍可提高精度 — 已完成（2026-09-13）

原缺口（三条，均属实）：

- JSON/XML parse error 可能归类为 network。
- 未特殊处理的 401/403 可能归类为 network。
- 平台返回格式变化可能没有归类为 parse。

已解决：写库失败不再冒充 `network`（新增 `storage` code，`isStorageFailure` 判定，
`channelSync` 与 `batchSync` 共用；**错误码驱动平台冷却**，所以这不只是文案问题）；
多源适配器（bilibili 等）在主源失败但仍有内容时返回 `degraded: true` + `warnings`，
由 `channelSync` 记 warn 日志，「安静地少数据」因此可被看见。

**本轮（2026-09-13）把剩下的三条一起收掉**，方式是让 HTTP 状态只有一个分类入口
`httpStatusError(status, platform)`（`src/adapters/types.ts`）。修复前实测的分叉：

| adapter | 修复前 | 后果 |
|---|---|---|
| weibo | 403→`auth`，**其余（含 429）→`network`** | 429 不进冷却 |
| xiaohongshu | **每种状态→`network`** | 404/429 全被当成连接问题 |
| pixiv / fantia | 状态塞进消息 → 外层 catch 归 `network` | parse 与 429 混为一谈 |

**429 报成 `network` 是行为性缺陷**：`rate_limit` 才会起**持久化**冷却（规则 19），
所以平台明确说「慢一点」时我们反而是当网络故障处理、继续按原速打。

映射：`429→rate_limit`、`401/403→auth`、`404/410→not_found`、其余 `4xx→network`、`5xx→network`。
「整个 try 包住采集」的 adapter（pixiv / fantia）抛 `HttpStatusError`，由 `toFetchError`
在最外层按状态定 `code`、保留 adapter 自己的文案；非该异常的抛出归 `parse`（缺字段是
schema 变化，不是网络故障）。

**验证**：15 例（映射 6 + 解析 4 + **四个 adapter 的端到端 429** 4 + 构造器 1），
变异 4/4 全杀（429 归 network、`toFetchError` 丢状态、4xx 全归 auth、xiaohongshu 退回 network）。

**仍然不做**：`FetchError.retryable`。该字段 2026-09-12 已删（全仓无读取方；且「按可重试性
重试」与规则 19 的冷却直接冲突——检测到限流后继续猛打比不检测更糟）。要按阶段重试应重新设计。

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
| weibo | **无** | 无 |
| pixiv | `pixiv.media.test.ts`（4 例，**2026-09-14**） | **有**（`tests/fixtures/pixiv/illust-147520202.json`，逐字取自 `/ajax/illust/{id}`） |
| fantia | `fantia.content.test.ts`（12 例）+ `fantia.repair.test.ts`（8 例）+ `fantia.repair.e2e.test.ts`（2 例，**2026-09-14**） | **有**（`tests/fixtures/fantia/`：club、post、俱乐部整页 6 条的真实详情，逐字取自真实接口） |

**最高优先是 Twitter 的真实 payload**：它的现有 fixture 是手工构造的，而该 helper 的历史版本
**把 bug 编码了进去**（嵌套多一层，正好匹配解析器当时读的位置，见规则 15/21）——
即现有 fixture 只能证明「解析器与自己一致」。

**另一类缺口：活模块无自动化验证**（既无测试直接 import，也无任何测试经由其它路径触达）。
**下表已于 2026-09-13 逐项复核，五行里三行已被后续批次关闭**：

| 模块 | 行数 | 状态 |
|---|---|---|
| `src/infrastructure/chrome/declarativeNetRequest.ts` | 186 | ~~无验证~~ **已完成 2026-09-13**：`tests/declarativeNetRequest.test.ts` 10 例，表驱动 + `initiatorDomains` 逐条断言（队列 #14） |
| `src/infrastructure/chrome/autoSync.ts` | 99 | ~~无单元判据~~ **已完成 2026-09-13**：`tests/autoSync.capability.test.ts`（筛平台 2 例）+ `channelSync.backgroundCapability.test.ts`（队列 #20） |
| `src/infrastructure/chrome/platformAuth.ts` | 66 | ~~无验证~~ **已完成 2026-09-13**：`tests/platformAuth.test.ts` 9 例（队列 #20） |
| `src/infrastructure/chrome/optionalHostAccess.ts` | 51 | **仍无**——`originPattern()` 可直测，`requestHostAccess()` 的弹窗行为只能真机观察（见下） |
| `src/sync/cursorState.ts` | 90 | 经消费点间接覆盖（**不是缺口**，见下） |

> **唯一剩下的真缺口是 `optionalHostAccess.ts`**：全仓 grep 无任何 import，`originPattern(url)`
> 是纯函数（把 URL 变成 `*://host/*` 授权模式）却没有测试，而它的输出直接决定向浏览器申请
> 哪个 origin。`requestHostAccess()` 本身依赖用户手势与真实弹窗，属真机范畴。

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

**`#19` 的 pixiv / fantia 已于 2026-09-14 完成，且此前「先抽解析段才能测」的判断是错的**：

当时的判断是：解析内联在 `fetchLatest` 里，必须先抽解析段才能测，而「先抽后测、没有真实载荷
兜底」是最该避免的顺序——于是把它记成「不能靠努力解决」。

批次 8 证明**不必先重构**。做法是：抓一份逐字真实载荷做 fixture，**用 `vi.mock` 替换
`src/infrastructure/chrome/http` 的 `bgFetch`**，然后**直接调 `fetchLatest`**——解析段依然内联，
但它读的就是真实响应，断言的是「同一份 fixture 产出什么」。载荷用 `curl` 加一个 `Referer`
即可取到（pixiv 的 `/ajax/illust/{id}` 是公开端点），不需要导出流程也不需要真机会话。

这暴露了原判断的漏洞：把「可测」与「可重构」绑在了一起。**内联解析不等于不可测**，
只要能把网络那一层换成 fixture。

**仍需要先抽解析段的情形**：要断言的是**纯函数级**行为（如「这个字符串怎么被解析」）时。
pixiv/fantia 这批断言的是「真实响应 → `Post` 的字段」，正好不需要。

**weibo 仍未做**（队列 #19 剩下的那半）。

### 4. 规则 8 的直连台账仍有 7 处

`entrypoints/ → src/infrastructure/db/*` 的直接 import，实测 **7 处使用**（不是 7 个文件，
`import type` 不计；`grep -rn "infrastructure/db" entrypoints/ | grep -v "import type"`）：

| 文件 | 用到什么 |
|---|---|
| `dashboard/composables/useDashboardShell.ts` | `db`、`settingsRepository`、`statsService`、`healBrokenPostMedia` |
| `dashboard/composables/useFeedFilters.ts` | `settingsRepository` |
| `dashboard/composables/useMediaMaintenance.ts` | `healBrokenPostMedia`、`cleanupOldPosts` |
| `popup/composables/useQuickFollow.ts` | `db` |

**口径**：优先加 service 方法，而不是新增直连 import；新增时**同一提交内**把文件加进
`AGENTS.md` 规则 8 的表。上一轮漂移的原因就是「一处」没有定义——现在定义为「使用次数」。

### 5. 新增平台仍涉及多个配置点 — 已按本节自己的标准收口（2026-09-13）

新增平台需要同步修改 adapter、registry、platform metadata、URL parser 与 cookie auth。
（域名这一侧已收敛：`PLATFORM_HOSTS` 是唯一来源，manifest 由其**派生**，代理白名单与
Referer 同样读它，见 AGENTS 规则 2；占位名前缀也已改为从 `urlParser.GENERATED_NAME_PREFIXES`
单一来源派生 + 双向守卫测试，见 `DEVELOPMENT.md` §6。）

**2026-09-13 实测：原先记的「8–10 个散点」已不成立，剩下的每一处都有守卫。**

- `KnownPlatform`（联合类型）与 `KNOWN_PLATFORMS`（数组）确实是**两份手写清单**，
  但**两个方向都由编译器兜住**，实测：只加联合不加数组 → `registry.ts` 报
  `Property 'ghostly' is missing in type … Record<KnownPlatform, PlatformAdapter>`；
  只加数组不加联合 → `Type '"ghostly"' is not assignable to type 'KnownPlatform'`。
  **无法静默漂移**——而这正是当初列这条的理由。
- `PLATFORM_REGISTRY` ↔ `KNOWN_PLATFORMS` ↔ `ADAPTER_MAP` 已由
  `tests/platformRegistry.test.ts` 双向断言（含「未知平台不得回退到别的 adapter」）。
- **本轮补的唯一真缺口**：`PLATFORM_HOSTS` 与平台键**没有**任何东西连接（一个键 vs 一组域名），
  新增平台忘了加 host 就拿不到 `host_permissions` 与凭据策略，而适配器照跑、请求全部匿名发出，
  看起来像平台侧问题。已补断言（含 `rss` **必须不在**白名单里的反向断言——规则 3）。

结论：**不引入 `PlatformDefinition`**。本节原本就写着「当前不应为预想需求提前增加复杂抽象」，
而实测表明「散点」已经各自被守卫覆盖，抽象会是为不存在的问题加复杂度。

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

- ~~**RSS**：`rss_${stableHash(guid)}`（`rss.ts:199`），而 `guid` 只保证 **feed 内**唯一。~~
  **已完成 2026-09-13**（`e86325a`）：身份改为 `hash(channelId + guid)`，存量行走适配器上报的显式配对迁移。原文留存：
  但 `Post.id` 与 `PostSuppression.postId` 都是**全库主键**。两个 feed 各发
  `<guid>1</guid>` → 同一篇内容；更糟的是在 A 上「彻底删除」会**顺带压制 B**。
  这不是「也许碰撞」，是两层 scope 没对齐。
- **媒体缓存**：目录是 `creatorName/platform/YYYYMMDD_postId前16位`
  （`pathResolver.ts`），而内存 object URL 用 `postId_mediaIndex`。
  三个 identity 互不相同：**创作者改名即失联**（缓存还在、找不到），
  且**已经有稳定完整主键却截成 16 位**做文件名。

### 10. 平台能力没有模型（能力错配）— 已完成（2026-09-13）

各模块单独看都对，组合起来互相否定（原文留存）：

- ~~`twitter.ts:137` 明确 `IS_SERVICE_WORKER → unsupported`，而 `autoSync.ts:50`
  `db.channels.toArray()` **不筛平台**——开了自动同步，Twitter 必然报不支持；~~
- ~~popup 首次抓取为了「关窗不中断」改走 `SYNC_CHANNEL` → SW（对），
  但新关注的 Twitter 频道因此**必然**撞上同一条 unsupported；~~
- ~~`channelSync.ts:248` 的 `signal: options?.signal ?? abortController.signal` 是**二选一**~~
- ~~`autoSync` 丢弃 batch 结果：**10 个频道全失败也记「后台自动同步完成」**~~

**四项全部完成**。修法（能力声明放 `PlatformAdapter`，`registry` 只查表、不做第二份真源）：

| 轴 | 缺省 | 声明为 `false` | 消费点 |
|---|---|---|---|
| `backgroundSync` | 是 | `douyin`、`twitter` | `channelSync` dispatch 前拒绝；`autoSync` 批量前筛掉并记日志 |
| `paginates` | 是 | `douyin`、`youtube`、`fantia`、`rss`、`xiaohongshu` | `cursorState.terminalCursorIsStated` 的新来源；`historySync` 的单发中断 |
| `archivesMedia` | 是 | `rss` | `imageCache` / 设置页（改走同一个 helper） |
| `digScrollsUserPage`（2026-09-14 加） | **否** | —（只有 `xiaohongshu` 声明为 `true`） | `useDeepSync` 的回溯前确认框措辞 |

`paginates` 顺手修掉一处**已分叉的第二真源**：`cursorState.ts` 的
`SINGLE_SHOT_ACQUISITION = ['douyin']` 与适配器各存一份，而 `youtube` / `rss`
**既不返回 `nextCursor` 也不返回 `hasMore`**（实测），同样无法声明「没有更早的了」——
它们不在那份名单里，于是为其记录的 `__END__` 被**当成平台声明而信任**（规则 10 的不对称）。

### 11. 数据访问是全量内存模型（规模）

`useDashboardData` 每次 reload：`healBrokenPostMedia()` → `creators.toArray()` →
`channels.toArray()` → `posts.orderBy(...).toArray()`，全部进 Vue 响应式；
筛选在内存里全表扫，`useWaterfallFeed` 的 `slice(0,36)` 只是 **DOM 分页，不是数据分页**。

与「深挖历史」这个功能**天然矛盾**：存得越成功，首页 reload 越贵。
且 `healBrokenPostMedia`（迁移/维护职责）被放在 **hot path**，每次读取都全库跑一遍。

修法见队列 #5（便宜的先行）/ #10（真重构）。

### 12. 工程质量项（不直接致错，抬高出错概率）

- ~~**E2E 一个 click 卡死一整串**~~ **已完成 2026-09-13**：竞态根因已修（规则 34），
  链路依赖也已拆开——`backup.export` 失败现在只 skip 3 步（真正依赖它的备份链），
  5 个 alarm 检查照常运行（实测：强制 export 失败 → `14 passed, 1 failed, 3 skipped`）。
- ~~**`PROXY_IMAGE` 无大小/MIME 上限**（`arrayBuffer()` 后直接 base64），
  而它现在允许任意 http(s) 主机（为 RSS 图片）——这是合理的产品行为，但没有 byte ceiling。~~
  **已完成 2026-09-13**（队列 #8）：`MAX_IMAGE_BYTES = 8MB` + `isImageMime()`，
  超限拒绝而不是先编码再丢弃；`tests/proxyImage.test.ts` 的
  `handleProxyImage — resource ceilings` 四例钉死（含「大但合法」仍要放行的反向断言）。
- ~~**`toSecureMediaUrl` 仍用 `includes()`** 判小红书域名。~~ **已完成 2026-09-13**：
  实测三个误判（路径里带域名、`xhscdn.com.evil.tld`、`notxhscdn.com`）都会把陌生主机的图
  改写到平台 CDN 上，且列表在 `media.ts` 与 `proxyImage.ts` 各写了一份——已解析化 + 收敛到 `hosts.ts`。
- ~~**DNR 186 行零测试**，且 `removeRuleIds` / `addRules` 两处手维护规则 id。~~
  **已完成 2026-09-13**：改为表驱动（`MEDIA_HEADER_RULES`），`removeRuleIds` 与规则体从同一处派生；
  新增 10 例测试，其中最重要的一条是**逐条**断言 `initiatorDomains` 作用域——那正是让规则
  不干扰用户其它标签页的安全属性，此前只写在注释里。改造经深比较**证明与原规则逐字节等价**。
- **无 MessageMap**：改一条消息要同步「五件套」，靠文档提醒。
- **新增平台 8–10 个散点**；`PLATFORM_REGISTRY` 不是 `Record<KnownPlatform, …>`。
- ~~**release.yml 跑 `npm test` 而 CI 跑 `test:coverage`**，注释却写「Same gates as CI」。~~
  **已完成 2026-09-13**（规则 35）：已对齐，并有 `tests/workflows.gateParity.test.ts` 从两个
  workflow 自身推导门禁清单来兜底。

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
| **2. 数据完整性** | 备份校验、RSS 身份作用域、`FetchError` 分类、`toSecureMediaUrl` 主机判定 **均已完成**（2026-09-13）；剩余仅媒体缓存的文件名截取 postId 前 16 位（**无老用户，已降级为不急**） | 这一层基本收口 |
| **3. 能力错配** | **整层已完成 2026-09-13**：取消信号、聚合诚实、Platform capability 模型（`backgroundSync` / `paginates` / `archivesMedia`）。后台/页面上下文的分工现在由适配器声明，消费点按声明筛选 | 已收口 |
| **4. 规模与性能** | 每次 reload 全库 `toArray` 进 Vue 内存（只显示 36 条），且**先**全库跑一遍 `healBrokenPostMedia` | 每次都付税，随历史增长恶化 |
| **5. 工程质量** | E2E 竞态根因、E2E 拆分、release/CI 门禁一致性、DNR 测试、平台散点守卫 **均已完成**；剩余 MessageMap 完整版（长期）与规则文档去重（低优先） | 已基本收口 |

**明确不做**：整体 UI 风格重设计（P6，用户不排期）、PR-first 工作流、待办迁 Issues
（单人维护，不引入协作开销）、往微交互追加工程资源（AUDIT P3 冻结）。

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

- **代码基线**：`master`，与 `origin/master` 同步。接手第一件事：`git status -sb`
  与 `git log -1 --oneline`（此处**不写提交哈希**——它每次提交都变，写死即过期）。
  **注意**：批次 8（2026-09-14）**尚未提交**——工作区有 4 个改动文件 + 4 个新测试文件
  + 1 个新探针，`git status --short` 会看到它们。先决定提交还是继续。
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
| **2** | ~~**SyncCoordinator**：同频道 single-flight + 跨入口平台节流~~ **已完成 2026-09-13** | 状态正确性 | `src/sync/syncCoordinator.ts` |
| **3** | ~~**RSS identity scope**：`guid` 只在 feed 内唯一，却当全局主键~~ **已完成 2026-09-13** | 数据完整性 | `e86325a` |
| **4** | ~~**单条/批量恢复共享同一策略**~~ **已完成** | 数据完整性 | 见 1 |
| **5** | ~~**`healBrokenPostMedia` 移出 reload hot path**~~ **已完成 2026-09-13** | 规模 | `d9bcd4e`；`runMediaHealingOnce` |
| **6** | ~~**Platform capability 模型**~~ **已完成 2026-09-13** | 能力错配 | `backgroundSync` / `paginates` / `archivesMedia`，三轴各有真实消费点 |
| **7** | ~~**取消信号可组合**：caller signal ∪ deadline~~ **已完成 2026-09-13** | 能力错配 | `composeAbortSignals` |
| **8** | ~~**`PROXY_IMAGE` 加 byte/MIME 上限**~~ **已完成 2026-09-13** | 数据完整性 | `MAX_IMAGE_BYTES = 8MB` |
| **9** | ~~**后端聚合诚实**：autoSync 把结果丢了~~ **已完成 2026-09-13** | 能力错配 | autoSync 报 `failed/total` |
| **10** | **Feed 数据分页**（IndexedDB query 取代全量 `toArray`） | 规模 | 全库进 Vue 内存，只显示 36 条 |
| **11** | ~~**E2E 拆独立 scenario**~~ **已完成 2026-09-13** | 工程质量 | 抽出 `dashboard.settings-tab`；export 失败导致的 skip 从 8 降到 3 |
| **12** | ~~**`FetchError` 五阶段细分**~~ **已完成 2026-09-13** | 数据完整性 | `httpStatusError` 唯一入口；429 不再被当成网络故障 |
| **13** | **媒体缓存 identity**：目录用 creatorName、文件用 postId 前 16 位 | 数据完整性 | 改名即失联；主键被截短**（无老用户，已降级为「不急」）** |
| **14** | ~~**DNR 规则表驱动 + 测试**~~ **已完成 2026-09-13** | 工程质量 | 表驱动 + 10 例；`removeRuleIds` 与规则表派生自同一处 |
| **15** | ~~**`toSecureMediaUrl` 的 `includes()` → `hostMatches`**~~ **已完成 2026-09-13** | 数据完整性 | 改用解析后的主机名；XHS 列表收敛到 `hosts.ts` |
| **16** | **MessageMap 类型协议**（长期） | 工程质量 | 完整版仍未做；**其可判定的一半已完成 2026-09-13**——`tests/messageRouter.test.ts` 钉住策略表↔分支双向一致 + fail-closed |
| **17** | ~~**Platform 声明性事实单一来源**~~ **已按本节标准收口 2026-09-13** | 工程质量 | 两份清单双向编译器兜底；补了 `PLATFORM_HOSTS` 覆盖断言；**不引入 `PlatformDefinition`** |
| **18** | **Twitter 真实 payload fixture** | 证据 | 手工 fixture 曾把 bug 编码进去 |
| **19** | ~~**weibo / pixiv / fantia 解析测试**~~ **pixiv + fantia 已完成 2026-09-14（批次 8）** | 证据 | 两者现用真实 fixture 直测（4 + 7 例）；**weibo 仍缺**——解析仍内联在 `fetchLatest` 里 |
| **20** | ~~**`autoSync` / `platformAuth` 单元测试**~~ **已完成 2026-09-13** | 证据 | `platformAuth` 9 例；`autoSync` 用法已在 `autoSync.capability.test.ts` 覆盖 |
| **21** | ~~**规则 8 台账收敛**~~ **已一致（2026-09-13）** | 工程质量 | AGENTS 与实测**均为 7 处**；剩余直连属既定欠债，不是数字漂移 |
| **22** | ~~**`AGENTS.md` 规则 9/28/30 压到 ≤8 行**~~ **已按实测改判 2026-09-13** | 工程质量 | 前提不成立（详见下）；改为**修规则 9 的误归类**，49 → 38 行 |
| **23** | ~~**`dashboardToolbar` 偶发未处理拒绝**~~ **已不复现（2026-09-13）** | 工程质量 | 连跑 5 次 0 次未处理拒绝；原 ~1/8 已不可观测 |
| **24** | ~~**release.yml 与 CI 门禁一致性**~~ **已完成 2026-09-13** | 工程质量 | 已对齐 `test:coverage`；`tests/workflows.gateParity.test.ts` 兜底 |
| **25** | **平台适配器接口里的 Twitter 私有方法** | 工程质量 | `parseGraphQLResult?` / `fetchAjaxFallback?` |
| **26** | ~~**小红书深挖只能取到最近一屏**~~ **已完成 2026-09-14** | 能力错配 | 页面驱动回溯（collector + contract + `FETCH_XHS_NOTES`）；**滚动是否真能加载第 31 条仍未实测**，见 `XIAOHONGSHU_RESEARCH` §9 |

| **27** | **删除「小红书图裂修复」**（`healBrokenPostMedia` + 设置页入口） | 工程质量 | 用户 2026-09-14 明确表态：「那个修小红书图裂的是超级老的功能了，后续已经可以考虑删了」。它做的事只有 `toSecureMediaUrl` 与头像 https 化，且**是全表 `toArray()` 扫描**；`runMediaHealingOnce` 已把它移出 reload hot path（#5）。删它要连**设置页按钮 + `useMediaMaintenance.handleHealBrokenMedia` + 规则 8 台账里的 `postRepository` 直连**一起动 |

**批次建议**（每批独立可交付、可验证）：

- **批次 1（状态正确性）**：#2 SyncCoordinator + #3 RSS identity + #7 取消信号。
  三者都是"同一次操作在不同时序/不同入口下结果不同"，一起做才不会出现三套补丁。
- **批次 2（规模）**：#5 hot-path 修复 + #9 聚合诚实——**两项均已完成**。
- **批次 3（能力模型）**：#6 capability（**未做**）+ #8 proxy 上限（**已完成**）。
- **批次 4（工程质量）**：#11、#24、#14、#16 的可判定半、#23 **均已完成**（2026-09-13）。
- **批次 5（证据）**：#20 已完成；**#18 仍阻塞**；**#19 的 pixiv/fantia 已完成（批次 8）**，
  只剩 weibo 未做。
- **批次 6（能力错配）**：**已完成**（#6，2026-09-13）。
- **长期**：#10 分页重构、#16 MessageMap、#17 平台单一来源、#13 缓存 identity。

---

#### 已完成（批次 9：fantia 正文仍显示原始 delta，2026-09-14）

用户第二次报「fantia 正文依旧不是纯文字」（附卡片截图 + 开发者日志）。**第一次诊断错了**，
按日志重判后根因不同。两次报的是**同一张卡片**，但它不是批次 8 修的那条
（批次 8 修 4228374；截图是 4236630）。

**日志给出的事实**（`local://paste-2.md`，03:30:37–40）：

```
fantia/迷夜ゆめ 开始同步（常规） | 上限 10 条，水位线 2026/9/13 11:29:37
bgFetch: fantia.jp → HTTP 200 | 23313 字符        ← 俱乐部列表成功
bgFetch: fantia.jp → HTTP 403 | 26 字符           ← 详情请求被拒（共 3 次）
channelSync: fantia/迷夜ゆめ 同步完成 | 新增 0 条，平台返回 6 条，hasMore=false
```

**真根因（三条叠加，全部有实测或日志支撑）**

| # | 事实 | 后果 |
|---|---|---|
| 1 | 存量行里存的是**原始 delta**（截图逐字：`{"ops":[{"insert":"本編→"},{"attributes":{"link":"…"},"insert":"…"},{"insert":"\n"}]}`） | 卡片渲染原始 JSON。这行是 `fantiaCommentText` 存在**之前**的构建写的 |
| 2 | 所有 6 条都**在水位线之下**（`新增 0 条，平台返回 6 条`） | 不走新行写入，只走**修复**分支 |
| 3 | 而修复规则当时要求 `content === title`——**delta 不等于标题** | 规则永不匹配，该行**每次同步都存活**。这才是用户「同步过了还是这样」的机制 |
| 4 | 详情请求 **403**（会话相关，匿名 200、登录态 403） | 正文与图集都拿不到更新；而这一失败**只记在 `bgFetch` 的 warn 里**，频道仍报「同步完成」 |

**修法**

1. **修复规则改为认「原始 delta」这个真实形态**（`isFantiaBodySuperseded`）：
   `fantiaCommentText(stored) !== stored` 即判定——**问的是解码器本身会不会改这个字符串**，
   与缺陷问的是同一个问题。仍保留 `content === title` 那条。`fresh !== stored` 两侧都要求，
   所以空的正文永远不会把行改写。
2. **详情请求失败上报为 `degraded` + `warnings`**（规则 13 的既有机制），
   措辞点名 403 与「正文与图集沿用列表数据」。此前平台拒绝与「账号本来就没内容」在界面上
   完全一样。
3. 批次 9 早前的两项改动保留（详情 `comment` 取回、`thumb_micro` 回退、上限 3→6）。

**为什么让修复能生效**：登录态下**列表本身**就带 delta（匿名列表 `comment: null`，
登录态 23313 字节 > 匿名 18603），所以 `fantiaCommentText` 在**列表路径**就能解出正文，
不需要那次 403 的详情请求。正文与图集因此**互不阻塞**。

**验证**

- **10 例**于 `tests/fantia.repair.test.ts`（含用户那行的**逐字** delta）+
  **2 例** `tests/fantia.repair.e2e.test.ts`，其中最关键的一条断言：
  `fantiaCommentText(存量的 delta) === 新解析的正文`——**这正是「替换是安全的」的全部理由**，
  若两者不等，修复就是拿一个错正文换另一个。
- **变异全杀**：去掉 delta 判定臂 → 红；把它放宽成 `body.startsWith('{')` → 红；
  详情失败不计数 → 「degraded」用例红。
- 全量 907 例通过；`typecheck` / `lint` 0 问题。

**已知未做 / 需要注意**

- **403 是平台行为，本地无法消除**：匿名访问详情端点 200，登录态 403。
  代价是**图集**（列表只给一张缩略图）；正文不再受影响。
- **未在用户会话复验**。用户刷新扩展后，4236630 的正文应显示
  `本編→https://fantia.jp/posts/3210183`；若仍显示原始 JSON，则说明列表路径也没解到，
  需要再取一次 `新增 0 条` 后的日志。

---

#### 已完成（批次 8：三个适配器缺陷 + 媒体卡片几何，2026-09-14）

用户报：pixiv 卡片「时间全是刚刚」「图片取不到」，fantia 正文渲染出 `{"ops":…` 原始 JSON，
小红书图裂，以及 pixiv 部分卡片**只显示一部分图片**。全部按**真实载荷**定位，未靠推断。

**根因与修复**

| 平台 | 根因（实测） | 修复 |
|---|---|---|
| pixiv | `/ajax/user/{uid}/profile/all` **只返回 id**。适配器用 ID 线性外推时间（作品 147520202 实际 2026-07-22，公式算成 2026-09-13，再被 `Math.min(Date.now())` 夹成「现在」）；预览写的是 `decorate.php` | 改从 `/ajax/illust/{id}` 读 `createDate`/`uploadDate` 与 `urls.regular/original`；排序移到补全**之后** |
| pixiv | 补全**每轮上限 3 个**，10 条里 7 条永远拿不到真图 | 上限删掉，改为按**请求**配速（`PIXIV_ENRICH_INTERVAL_MS`）——被计量的是请求，不是作品 |
| fantia | `comment` 可能是 **Quill delta**（`{"ops":[…]}`），原样写进 `Post.content` | 新增 `fantiaCommentText()` 解码为纯文本 |
| fantia | 正文与图集的键名**都不存在**：读 `post_content`（实际 `post_contents`）、判 `category === 'photo'`（实际 `photo_gallery`）、找 `photos[].url`（实际 `photo_gallery` 块里的 `post_content_photos_micro` 字符串数组） | 三处键名按真实响应改正 |
| 小红书 | `__INITIAL_STATE__` 是 **JS 对象字面量而非 JSON**，含 `new Map([])`；旧清洗只处理 `undefined`，整段解析抛异常 → 详情页拿不到 `imageList` → 多图笔记只留封面 | `toJsonObjectLiteral()` 改为**字符串感知扫描**，处理 `new Map/Set/WeakMap/WeakSet/Date`、`NaN`、`±Infinity` |

**`decorate.php` 的更正（重要，我上一轮写错了）**：它 **不是** HTML 页面，实测
`Content-Type: image/png`、640 588 字节、magic `89 50 4e 47`——**它是能渲染的**。错在别处：
它是**固定尺寸的装饰外框**，不随作品比例变化。所以该缺陷表现为「图不对」而非「图裂」，
这也解释了为什么它长期没被当成故障。代码注释已按实测改写。

**pixiv「只显示一部分图片」——与数据库无关**

先读了用户 Chrome 里的 IndexedDB（`chrome-extension_mjeipbjijdjbldfdljijkaofbkbffabc`）：
**全部 40 条 pixiv 记录的 URL 都是真的 `i.pximg.net`、日期全对**（7/14、7/06、6/29、6/21、
6/18、6/12，与截图逐条吻合）。所以**不需要修数据**，症状在渲染层。

真因在 `PostCard.vue` 的单图容器：`max-h-[460px]` 把高度封在 460，`object-cover` 再裁。
在真实渲染引擎里量到（`e2e/media-card-geometry.mjs`）：900×1200 的作品在 **433px 列**下得到
**433×460** 的框——比例被从 0.75 扭成 0.94，于是裁掉两边。**只有比例低于列宽的竖图受影响**
（801×1200、900×1200），横图（比例 ≥ 1）从来没事——这正是用户点名特定几张的原因。

改为 `h-auto` + `max-h-[560px]` + `object-contain`。改后同一次实测：`433×560`、
`object-fit: contain`、**0 张裁切**。

**第二处空白**：卡片在磁盘探测返回前不渲染 `<img>`（只显示脉冲占位图标）。探测会遍历
`CACHED_IMAGE_EXTENSIONS` 逐个读文件，慢了就一直空白，而且**看起来像"加载中"不像故障**。
加 `MEDIA_PROBE_DEADLINE_MS = 700`：到点先显示网络图，探测结果回来再升级为本地 blob。
40 个真实 URL 并发实测：**0 张失败**，中位 2410ms、最慢 2996ms（所以 URL 层没问题）。

**证据与验证**

- **20 例新测试**（pixiv 4 / fantia 7 / 小红书 9），fixture **逐字取自真实接口**
  （`tests/fixtures/pixiv/`、`tests/fixtures/fantia/`）——这三个适配器此前**一个测试都没有**。
- **变异 6/6 全杀**。含一条元教训：第一轮变异脚本报「6/6 SURVIVED」，实为 Windows 下
  `subprocess` 读不到 vitest 输出的**假绿**（规则 26 的原话），改用 shell 重跑后全部 KILLED；
  且中途有一个变异**未还原**，已核查并修复。
- 端到端确认详情页路径：`state.note.noteDetailMap[id].note.imageList` 现在可读（修复前为 `null`）。
- **新探针 `e2e/media-card-geometry.mjs`**（独立 profile，规则 25/28）：播种真实比例的作品，
  量 holding box / `object-fit` / 是否裁切，有裁切或未加载则退出码 1。

**已知未做**

- **未在用户的真实会话里复验**。当前证据是：数据库逐条核对 + 独立实例实测 + 40 个 URL 全通。
  用户需要刷新扩展后实际看一眼（`.output/chrome-mv3` 已是最新构建）。
- 「空白」的第二机制（探测慢）**未在用户环境复现**，只做了机制分析与上限修复；上面 40 URL
  实测说明网络层不背这个锅。
- 未提交。

---

#### 已完成（批次 7：小红书历史回溯，2026-09-14）

**#26 小红书深挖只能取到最近一屏** —— **已完成（2026-09-14）**。

**背景**（`docs/XIAOHONGSHU_RESEARCH_2026-09.md`）：主页文档只带一屏（约 30 条），下一页接口
`user_posted` 需要页面运行时生成的 `X-S` 签名。**签名路线已在 `DOUYIN_RESEARCH` 明确排除**
（会把扩展变成搬运签名与设备标识的东西），所以能走的只有页面驱动滚动 —— 而这份调查自己写下的
设计方向是「常规同步保持 `bgFetch`，只有带游标的深挖走页面驱动」。本批实现了那个方向。

**改了什么**

| 文件 | 作用 |
|---|---|
| `src/adapters/xiaohongshu/collector.ts` | 注入页面的采集器：滚动**所有**可滚动祖先 + 窗口，从 `__INITIAL_STATE__` 读笔记 |
| `src/adapters/xiaohongshu/contract.ts` | 校验不可信快照（id 24 位十六进制、时间有限、媒体必须 http(s)） |
| `src/infrastructure/chrome/messages/xiaohongshuNotes.ts` | `FETCH_XHS_NOTES` handler：标签页生命周期、`world: 'MAIN'`、把「无返回值」当「没跑」并重试 |
| `src/adapters/xiaohongshu.ts` | 按 `isDeepRequest` 分流；新增页面路径的映射与端点判定 |
| `entrypoints/dashboard/composables/useDeepSync.ts` | 回溯前确认框（由 `digScrollsUserPage` 驱动，≥3 个账号时加重措辞） |
| `src/adapters/types.ts` | 新增 `digScrollsUserPage`（缺省 `false`）+ `digRisksUserAccount()` |

**过程中抓到两个我自己的真实缺陷**（都由测试/变异发现，不是推测）：

1. **模块级常量 = 规则 9 的原形态，且只在求值源码时可复现。** collector 一开始把
   `SCROLL_MIN` / `SETTLE_MS` 等放在模块作用域 —— `executeScript` 只序列化函数本身，
   注入后这些标识符**不存在**。用 `new Function('return (' + fn.toString() + ')')()` 求值
   立刻得到 `ReferenceError: SCROLL_MIN is not defined`。这正是 Twitter bearer 那一类
   （「页面路径从未运行过，且没有任何东西能看出来」），新测试就是这个模板。
2. **`/作品\s*(\d+)/` 把「作品 1.2万」读成 1** —— 而 `notes.length >= statedTotal` 一旦
   为真就返回 `hasMore: false`，`channelSync` 随即写入 `__END__`，**永久封死**这个大 V 的
   历史回溯（规则 10 不可恢复的那个方向）。现在只接受纯整数（含千分位），缩写/小数一律
   视为**未知**，未知永不构成完整性证据。

**分层的两个判断，都基于实测而非直觉**

- **`backgroundSync` 保持为真、`paginates` 保持为假。** 实测：worker 里 `douyin`/`twitter`
  在发出任何请求**之前**就拒绝（bgFetch=0），而小红书**照常发出请求**（bgFetch=1）——
  所以常规同步确实能在 worker 内完成，声明 `false` 会把一个能用的平台从自动同步里摘掉。
  `paginates` 问的是「平台是否签发真实游标」，注入路径用的是本地偏移，答案仍是否。
- **单发中断从 `platform === 'douyin'` 改为读 `paginates` 声明。** 该处注释本来就写着
  「scoped to the single-shot acquisition model」，而小红书加入后，写死名字会让它**每轮
  重滚同一页四次** —— 在同一批风控最在意的平台上，四倍的自动化信号，换零条新数据。

**验证**

- **15 例新测试**：注入采集器（求值源码）9 + 边界校验 3 + 头部计数 1 + 单发模型 2；
  另有页面驱动的适配器用例 11 与回溯确认框 5 重写/新增。
- **变异 5/5 全杀**：模块级常量 → `ReferenceError`；缩写计数 → 读成 1；写死 `'douyin'`
  单发名 → 小红书滚 5 轮；默认值反向 → 给 bilibili 也弹确认；页面分流去掉 `world:'MAIN'`
  的等价改动由 `IS_SERVICE_WORKER` 拒绝用例覆盖。
- 三处**既有测试被本批改动推翻**，均已按新契约重写而非放宽：`xiaohongshu.parse.test.ts`
  的深挖组（旧断言的是 SSR 本地偏移，那已是死代码）、`platformCapabilities.test.ts` 的
  「声明与实际一致」（它按**源码文本**正则匹配 `IS_SERVICE_WORKER`，而它自己的姊妹用例
  正批评这种做法；改为**行为**断言：worker 里是否真的发出请求）。

**仍未验证**（写进 `XIAOHONGSHU_RESEARCH` §9，不要当成已结论）：滚动是否真的让小红书加载出
第 31 条之后的内容。本批断言的是代码性质（状态增长则收集器增长、三轮不增长即停、常量不能是
模块级），不是平台行为。要证它得用 `e2e/xhs-scroll-probe.mjs` 跑一次真实已登录账号。

---

#### 已完成（批次 1：状态正确性，2026-09-13）

**CI 红灯根因 —— `dismissDialogs` 竞态（2026-09-13）**

**现象**：40 次 run 里 8 次失败（20%），且**8/8 全部卡在同一步 `backup.export`**。
失败信息自称 `this is the environment, not the view under test` ——正是这句话让红灯被当成噪音。

**根因**：`dismissDialogs` 只探一次「现在有没有 dialog」，没有就返回。它假定
后续 dialog 是**同步**入队的（注释原文如此），但导入路径在两者**之间**还 `await` 了
`backupService.restore()` 与 `reloadData()`：

```ts
const replace = await dialog.confirm(...)   // ← 门禁在这里应答
deps.settings.value = await backupService.restore(...)  // ← 异步空窗
await deps.reloadData()                                 // ← 异步空窗
await dialog.alert('已恢复为备份快照…')      // ← 空窗之后才入队
```

探测正好落进空窗 → 返回早 → alert 随后挂载，其 `z-50` 遮罩吞掉下一次点击
（`mousedown=0 mouseup=0 click=0`，坐标系完全正常——所以它看起来像环境问题）。

**复现**：把那段间隔拉宽到 300ms，同一台机器上
**旧门禁 3/3 失败**（症状与 CI 逐字一致），**修好后 5/5 通过**；
900ms 间隔也通过（说明修法不依赖某个具体数值）。

**修法**：不再假设同步。`answered > 0` 之后，要求「连续 `DIALOG_SETTLE_MS` 内没有新 dialog」
才认定突发结束，总预算 `DIALOG_SETTLE_BUDGET_MS` 封顶（规则 24：量级要显式）。

**#22 `AGENTS.md` 规则瘦身 —— 已按实测改判并完成误归类修正（2026-09-13）**

**原目标（规则 9/28/30 各压到 2–8 行）建立在一个未经验证的前提上，实测后撤销。**

先量准（原队列行写「51/49/53」，我中途一次度量算成 188——度量口径不同，以逐规则 `## n.` →
下一个 `---` 为准）：规则 9 = **49** 行、规则 28 = **48**、规则 30 = **52**。

再逐条比对 `AGENTS_CASES.md`——结论**与预期相反**：

| 规则 | AGENTS | CASES | 说明 |
|---|---|---|---|
| 9 | 49 | 28 | **AGENTS 更长**；4 条操作要点在 CASES 里**一条都没有** |
| 28 | 48 | 100 | AGENTS 已是精简版 |
| 30 | 52 | 90 | 同上 |

CASES 自述为「**拆分前的完整原文，冻结**……作用是作证据，**不是约束**」。它存的是事故经过与
实测数字，**没有规则的操作要点**（「按结果断言而不是按没抛异常」「求值函数源码」「不要持久化
签名 URL」等只在 AGENTS.md 里）。所以**压到 ≤8 行等于删除唯一副本**，且会把约束写进一个
自称「不是约束」的冻结文件——与规则 33 是同一类错误。

**真问题只有一处**：规则 9 标题是「页面驱动平台把采集隔离在独立层」，却挂着两条与采集无关的
不变量（那是「Two further invariants this exposed」的遗留）。按用户决定**只修误归类**：

- **不要持久化签名 CDN URL** → 移入**规则 16**（讲「已写入的行怎么修」，这是「写什么进库」的规则）；
- **新增平台要把占位前缀加进 `GENERATED_NAME_PREFIXES`** → 移入 **`DEVELOPMENT.md` §6** 的
  「新增平台」清单——那里**已有更完整的一份**（含双向守卫测试与旧行兜底），规则 9 那份是副本。

规则 9：49 → **38** 行（31 行自己的主题 + 指向新位置的说明）。顺带修掉三处因误归类而指错的引用：
`tests/urlParser.test.ts` 的注释、`ARCHITECTURE.md` §4.1、`PROJECT_PROGRESS` 二.5。

**没有删掉任何约束**——两条不变量都在新位置，且在更贴题的地方。

**#6 Platform capability 模型 —— 已完成（2026-09-13）**

能力**由适配器自己声明**（用户 2026-09-13 拍板：registry 只汇总/查询，不做第二份真源——与
`minRequestIntervalMs` / `archivesMedia` 同形，也是规则 2 的形状）。

**三轴，每轴都有真实消费点**（不加没有读取方的字段——这正是当初删掉 `FetchError.retryable` 的理由）：

| 轴 | 缺省 | `false` | 消费点 |
|---|---|---|---|
| `backgroundSync` | 是 | `douyin`、`twitter` | dispatch 前拒绝 / autoSync 批量前筛掉 |
| `paginates` | 是 | `douyin`、`youtube`、`fantia`、`rss`、`xiaohongshu` | `terminalCursorIsStated` / 单发中断 |
| `archivesMedia` | 是 | `rss` | imageCache / 设置页 |
| `digScrollsUserPage` | **否** | —（`xiaohongshu` 为 `true`） | 回溯前确认框（2026-09-14 加） |

**修掉的两个真实缺陷**：

1. **popup 关注抖音/Twitter 必然失败**。`SYNC_CHANNEL` **刻意**在 worker 内运行（这样关窗
   不中断抓取），而这两个平台的采集是页面/消息往返——于是频道被存下、首批动态永远抓不到。
   现在在 dispatch **之前**按声明拒绝，并把「请在仪表盘手动同步」写进消息。
2. **`SINGLE_SHOT_ACQUISITION` 是第二真源且已分叉**。`cursorState.ts` 的 `['douyin']` 与适配器
   各存一份；实测 `youtube` / `rss` **既不返回 `nextCursor` 也不返回 `hasMore`**，同样无法
   声明「没有更早的了」，却不在名单里——**为它们记录的 `__END__` 被当成平台声明而信任**
   （规则 10：误判「已到底」不可恢复）。现由 `paginates` 单点派生。

**autoSync 的跳过是记账的，不是静默的**：筛掉后记一条 info，点名跳过了哪些平台。沉默会是
这个文件刚修过的同一个缺陷形态（分不清「不适用」与「忘了试」）。

**验证**：14 例新测试（映射/缺省语义 3 + 声明与实际行为一致 5 + channelSync 拒绝 4 + autoSync 筛选 2），
含一条**双向**断言——适配器声明 `backgroundSync:false` 就必须真的检查 `IS_SERVICE_WORKER`，
所以声明与实现无法各自漂移。**变异 6/6 全杀**：douyin 不声明、cursorState 退回私有名单、
channelSync 不拒绝、autoSync 不筛、筛了不记日志。两处曾**存活**（消费者无测试），因此补了
`tests/channelSync.backgroundCapability.test.ts` 与 `tests/autoSync.capability.test.ts`。

**#24 release.yml 与 CI 门禁一致性 —— 已完成（2026-09-13）**

`release.yml` 写着「Same gates as CI: a release must never be the first place a broken build is
discovered」，然后跑 `npm test`，而 CI 跑 `npm run test:coverage`。**这一字之差是有后果的**：
`vitest.config.ts` 里的分文件分支阈值**只在 coverage 模式下生效**（`ci.yml` 自己的注释就写着
这一点），所以那道保护「三个会静默损坏用户数据的模块」的棘轮，**在发布路径上根本不存在**。
发现方式是人工对读两个文件——**没有任何东西会红**。

**为什么不是「改一个字」就完事**：两个文件各自手工维护一份门禁清单。这和规则 27 缺失的
模板导入、规则 33 未登记的导出是同一个形状——**清单靠手抄，注释里写着承诺，两边分叉时没有信号**。
只改那一字，下次加门禁还会只加一边。

**改法**：
- `release.yml` 的测试步骤改为 `npm run test:coverage`（与 CI 逐字一致）。
- 新增 `tests/workflows.gateParity.test.ts`：**从两个 workflow 自己的 `run:` 行推导**各自调用了
  哪些 npm script，然后要求 release 覆盖 CI 的每一个。推导而非硬编码，所以「CI 加了门禁、
  release 忘了」也会红——否则这张清单自己也会过期。
- 两处**已测实的合法差异**用 `SATISFIED_BY` **显式声明**，而不是放宽成「大致相等」：
  - `test:coverage` 只能由 `test:coverage` 满足（单向，`test` 不算）；
  - `build` 可由 `zip` 满足——**实测**：删掉 `.output/` 后 `npm run zip` 会重新生成
    `.output/chrome-mv3`（规则 21：不要靠未验证的上游行为）。
- 另外断言 E2E 的**调用方式**两边逐字相同：那个 `-s "-screen 0 1920x1080x24"` 曾经是真缺陷
  （`xvfb-run` 默认 1280x1024 比 1440 宽的窗口还窄，窗口边缘的点击会被 X server 丢弃），
  一份配方两个调用方，不该各写一遍。

**验证**：3 个变异全部被具名断言杀死——
把 release 改回 `npm test` → `does not run: test:coverage`；删掉 release 的 lint 步骤 →
`does not run: lint`；把 E2E 调用去掉 `-s` 屏幕参数 →
`the E2E gate invocation differs between CI and release`。恢复后全绿。

**#2 SyncCoordinator** —— **已完成**。新增 `src/sync/syncCoordinator.ts`。

六条入口（Dashboard 全部刷新 / 创作者 / 单频道 / 深挖、popup 的 `SYNC_CHANNEL`、alarm）
全部经 `updateChannel`，而那里**没有任何并发锁**——`status: 'updating'` 是写入的字段、
不是互斥。同一频道可被并发采集，各自持有不同时刻的快照，**后完成的覆盖前面的**，
`nextCursor` 被旧的覆盖（深挖静默回退/跳段），且**用户看不见**。

- **同频道 single-flight**：加锁点放在 `updateChannel`——这是六条入口唯一的共同交叉点。
  按调用方各自加 `isSyncing` 看不见别的上下文（alarm 在 SW、popup 在另一个上下文）。
  第二个调用**加入**第一个并拿到同一个结果，因此一次采集、一次写入。
- **平台节流改为跨入口共享**：原来 `platformLastFinished` 是 `batchSync` 的**每次调用局部变量**，
  两个批次并发时各自认为「这个平台从没被请求过」，双双立即发出——恰好在平台即将承受最多请求时
  击穿了保护下限。现在由 `updateChannel` 在 **finally**（含失败路径）记录，`batchSync` 读共享值。

**#3 RSS identity** —— **已完成**。`<guid>` 按 RSS 规范只在**单个 feed 内**唯一，
而它被哈希成全库主键（`Post.id` 与 `PostSuppression.postId`）。两个源都用 `<guid>1</guid>`
是合法的，于是两条内容塌成同一个 Post，且**彻底删除一个会顺带压制另一个**。
改为 `hash(channelId + guid)`，即身份是 `(feed, item)`。

**存量行**：用**适配器上报**的方式迁移，而不是写一个 Dexie migration。
关键理由（我第一版做错了）：migration 要从 `originalUrl` 反推新 id，而适配器是从 `guid` 推——
**两者对「裸数字 guid」的源并不相同**，会产生适配器永远不会再生成的 id。
现在适配器在解析循环里同时算出「新 id」和「该条目在旧方案下的 id」并一起返回，
`channelSync` 用它把存量行、它的 suppression、它的 recycle snapshot 一并搬过去——
**只限于适配器刚返回的那一页**（规则 16）。

**过程中抓到我自己引入的一个真 bug**：迁移把 `isRead: 1` 搬过去之后，
紧接着的 `bulkPut(enhancedPosts)` 用适配器的新行（`isRead: 0`）把它盖掉了——
**迁移先搬、写入后抹**。已修：写新行前先读回该 id 的存量状态并合并。

**#7 取消信号** —— **已完成**。`signal: options?.signal ?? abortController.signal`
是**二选一**，不是组合：只要调用方传了 signal，45 秒期限就失去唯一的取消手段——
超时拒绝的同时底层请求仍在跑（正是 P1-2 当初要修的形态）。今天没有调用方传 signal，
所以它一直没暴露——**这个缺陷在等需要它的那个功能**。改为 `composeAbortSignals`
（`AbortSignal.any` + 手写回退）。

**验证**：三组变异共 **14/14 全杀**，包括「去掉 single-flight」「锁按平台而非频道」
「不释放锁」「失败时不记录节流」「取消退回二选一」。最后一组第一次**没抓住**——
我断言的是「调用方 abort 时适配器也 abort」，而 `??` 在那个方向**是对的**；
真正坏的是「期限还能不能取消」，改断言后才杀掉。



#### 已完成（上一批）

**#8 传输截断静默 / `PROXY_IMAGE` 无上限** —— **已完成（2026-09-13）**。

**这是从用户日志里挖出来的缺陷，比它表面更大。** 一次「刷新全部」的日志里三个失败，
其中两个**是同一个 bug**：RSS 源与小红书主页的响应都是**恰好 250,000 字符**——
`bgFetch` 的上限。

量出来的事实：

| 项 | 数字 |
|---|---|
| 用户那个 feed 的真实大小 | **268,021 字符**（10 篇） |
| 旧上限 | 250,000 → **在 `<img>` 标签中间砍断**：`…m001_45d99f51.png" alt=""&gt;&lt;/p` |
| 后果 | 结尾的 `</content:encoded></item></channel></rss>` 从未到达 → XML 必然 malformed |
| 上游设计要保留的量 | 每篇 HTML 60,000 × 10 = **600,000** |

**最后一行是关键**：传输上限（250k）**小于**下游被设计成要保留的量（600k）——
这个上限本身就不自洽。

**更糟的是它静默**：`readCapped` 砍掉内容后照常返回字符串，调用方无法区分「完整」与「被砍」，
于是把**我们自己的截断**报成「源返回的内容不是有效 XML」/「页面结构可能已调整」——
两次都把用户指向错误的排查方向。

**改法**：
- 上限 250,000 → **1,000,000**（保住那个真实 feed 有 3.7× 余量；本仓实测最大单篇 31,144
  字符的 32 倍）
- `readCapped` 返回 `{ text, truncated }`，经由 `BgFetchResult` / `HttpResponse` 一路传下去
- RSS 与小红书**先查这个标志**：被截断时明说「超过单次请求上限而被截断」，不再诬赖源
- `bgFetch` 对「HTTP 200 但被截断」也记 `warn`（那是真实降级，只是状态码好看）

**验证**：把用户的真实 feed **逐字抓成 fixture**（361,621 字节、10 篇、尾部完整——
规则 15/21：真实载荷，不是手写），测试它现在能完整解析；反向再测「砍到 250,000 且带标志」
时必须说「截断」而**不得**说「不是有效 XML」。4 个变异全部被具名测试杀死
（含把上限改回 250,000 —— 只有真实 fixture 能抓住它）。

**仍未做**：`PROXY_IMAGE` 自身的 byte/MIME 上限（图片走的是另一条路径，见队列 #8 原文）。

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
  **HEAD 的红灯是真实状态**（以 `gh run list` 为准），但红因是一处**门禁自身的竞态**，
  不是业务代码回归。
  > **2026-09-13 更正**：原文说「两次红都发生在纯文档提交上」——**实测不成立**。
  > 40 次 run 里 8 次失败（20%），**8/8 全部卡在同一步 `backup.export`**，
  > 提交类型（文档 / 代码）与红绿无关，那是巧合。详见「已知陷阱」。
- **「restore-all 是没人注意的实现遗漏」**——不准确。它是 `DELETION_MODEL.md` 第 48 行
  **用户已确认的语义**（「全部恢复 → suppression 全部删除」）。真正的性质是
  **既定语义与「彻底删除」的界面承诺冲突**，所以解法是拆动作、不是改语义。
- **平台 `platform` 字段做枚举校验**——会让平台移除前导出的备份全部无法导入，见 A1。
- **PR-first 工作流 / 待办迁 GitHub Issues**——`PRODUCT_DECISIONS.md`，单人维护的项目不引入协作开销（与仓库是否公开无关）。

---

#### 仍不可验（环境限制，别浪费时间重试）

- **alarm 跨浏览器重启的长期行为**：CDP `loadUnpacked` 加载的扩展不跨重启留存，
  重启后重新加载等同全新安装。要验只能在真实安装的扩展上做。
- **Twitter / 抖音路径的固有脆弱性**（二.6 / 二.7）：属外部依赖，本地重构无法消除。
- **`healBrokenPostMedia` 的真实收益**：本地无大库，无法测量它在大历史下的实际代价（#5）。

#### 已知陷阱（踩过，省你时间）

- 扩展 E2E 必须带 `--enable-unsafe-extension-debugging`，否则 `Extensions.loadUnpacked`
  报 `Method not available`（规则 28）。
- **E2E 的 `mousedown=0` 不是环境问题**（2026-09-13 定位并修复）。旧笔记与失败信息都写着
  「this is the environment, not the view under test」——**那句话是错的，也是没人继续查的原因**。
  真因是 `dismissDialogs` 里一个**竞态**：导入路径在 `dialog.confirm(...)` 与随后的
  `dialog.alert(...)` **之间**还 `await` 了 `restore()` 与 `reloadData()`，而这期间页面上
  **没有任何 dialog**。旧实现只探一次，正好落在这个空窗里就返回，紧接着 alert 挂载、
  其 `z-50` 遮罩吞掉了下一次点击（`download.export` 的按钮点击全被吃掉）。
  本地复现方式：把那段间隔拉宽到 300ms，旧门禁 **3/3 失败**、修好后 **5/5 通过**。
  修法：`answered > 0` 之后要求「连续 `DIALOG_SETTLE_MS` 内没有新 dialog」才认定突发结束
  （带上限 `DIALOG_SETTLE_BUDGET_MS`），而不是假设后续 dialog 是同步入队的。
- 导入成功路径的 `alert()` **阻塞渲染进程**，连带 `Runtime.evaluate` / `Page.enable` 永久挂起；
  须在执行动作前启用 Page 域并应答 `Page.javascriptDialogOpening`。
- 视觉验证只开独立 profile 的专用实例，绝不驱动用户正在浏览的窗口（规则 25）。
  **`--window-position=-2400,-2400` 不够**——窗口仍会出现在任务栏，要**最小化**（规则 28）。
- jsdom 不做布局：几何问题用规则 30 的单文件 HTML 打包在真实排版引擎里量。
- 脚本化改写必须断言命中数，否则「匹配不到」会产出假绿（规则 26）。
- **Windows 上 Python `subprocess` 读不到 vitest 的输出**（2026-09-14 踩到）：在 `eval` 里
  无论 `capture_output=True` 还是重定向到文件，`stdout` 都是**空串**，而 `rc` 还可能是 0。
  变异测试因此报出**全绿假象**——「N/N SURVIVED」+ 空输出就是它，不是真的存活。
  验证方式：同一命令在 `bash` 工具里跑得到 `Tests N passed`。变异一律用 bash 跑。
- 本仓库 `core.autocrlf=true`：签入为 LF，工作区可能是 CRLF，多行锚点会匹配不到。
- **代理派活**：穷尽式核查用 `reviewer` / `task`，**不是** `scout`；多代理写同一文件必须先
  经 `hub` 协调边界（规则 31，含 2026-09-12 的复发案例）。
