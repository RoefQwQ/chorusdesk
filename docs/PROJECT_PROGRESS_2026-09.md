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

- **数据入口**：备份导入的校验只到「必填字段存在」，未达完整 schema（二.1）。
- **失败语义**：`FetchError` 的 HTTP/解析/schema/timeout 四阶段细分仍未做；401/403 未专门归类。
  写库失败已不冒充 `network`（新增 `storage` 域），多源适配器可报 `degraded`（二.2）。
- **证据缺口**：真实载荷 fixture 只覆盖 4 个平台（bilibili / douyin / rss / xiaohongshu）；
  weibo / pixiv / fantia 三个适配器连解析测试都没有（二.3）。
- **无测试的活模块**：`declarativeNetRequest.ts`（186 行，全部防盗链规则）零测试引用（二.3）。
- **债务台账**：规则 8 的 `entrypoints → infrastructure/db` 直连仍有 8 处（二.4）。
- **外部依赖风险**（本地重构无法消除）：Twitter/X 路径先天脆弱（二.6）、抖音 DOM 耦合（二.7）。
- **待真机确认**：见[四.P7](#p7真实浏览器行为验证滚动清单) —— RSS 阅读视图、抖音重试期限、
  图片代理 403 冷却。
- **未排期**：四.P6 整体 UI 风格重设计。
- **已否决（不要重新提出）**：PR-first 工作流（[PRODUCT_DECISIONS.md](PRODUCT_DECISIONS.md)）。
- **待用户拍板**：AUDIT P2-17（a）待办是否迁 GitHub Issues。

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

### 1. 备份校验不是完整 schema

`parseBackup`（`src/infrastructure/db/backupRepository.ts`）已做：版本白名单
（`['1.0','1.1']`，不是相等判断）、`creators/channels/posts/suppressions` 必须是数组、
`settings` 必须是对象、每条记录的**必填字段存在性**、以及抑制记录的
`postId`/`platform`/`suppressedAt` 校验。

**仍未做的检查**：

- timestamp 必须为有限数（`Number.isFinite`）。
- `platform` 必须是已知枚举成员。
- 跨表引用完整性（channel→creator、post→channel）。
- 重复 ID。
- settings 的字段范围。
- `isRead` / `isBookmarked` 必须为 `0|1`（AGENTS 规则 5：别的值会被索引静默丢弃）。

**为什么重要**：导入是**唯一**能绕过全部仓储层写入路径的入口，因此这几条正是「一个坏文件
能进来的方式」。优先级为二类中最高。

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

本项目的成熟度瓶颈**不在代码结构**，而在两处：**数据入口的严谨度**与**证据的可信度**。
下面的排序据此而来；每条都能在 [四.P8 队列](#p8交接队列与未来方向唯一待办入口)找到可执行条目。

| 方向 | 为什么现在做 | 代价 | 对应条目 |
|---|---|---|---|
| **1. 备份/导入的完整校验** | 导入是**唯一**绕过仓储层写入的入口（二.1）。抑制记录的语义是「跨取关、跨重装」，而重装后靠备份往返恢复——校验不足会让刚建立的删除语义从后门被绕过（`DELETION_MODEL.md` 不变量 I8 正是这条） | 中（纯校验，无 schema 变更） | A1 |
| **2. 真实载荷证据** | 现有 Twitter fixture 是手工构造的，其历史版本**把 bug 编码了进去**（二.3）；「测试与实现出自同一模型时，双方共享的错误世界模型不会被任何一方发现」 | 低（一次真机会话即可取到） | B1 |
| **3. 无自动化验证的活模块** | `declarativeNetRequest`（186 行防盗链规则）静默失效的表现是「图片变占位」，而它零自动化验证（二.3） | 低（规则集是纯数据） | A3 |
| **4. 失败语义细分** | 分类错误会**驱动平台冷却**，所以错的不只是文案（二.2） | 中 | A2 |
| **5. 平台测试覆盖补平** | weibo / pixiv / fantia 零解析测试；做法已有先例（bilibili / xiaohongshu 的「先建网再动刀」） | 中高 | B2 |
| **6. 债务与文档收尾** | 规则 8 台账 8 处直连；`AGENTS.md` 三条超长规则 | 低 | A4 / A5 |

**明确不做**：整体 UI 风格重设计（P6，用户不排期）、PR-first 工作流（已否决）、
往微交互追加工程资源（AUDIT P3 冻结）。

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

#### 队列 A — 立即可做，不需要用户输入（建议按序）

A1. **备份校验补全**（二.1）。这是**数据入口**，优先级最高。逐项加：timestamp 有限性、
    platform 枚举、跨表引用、重复 ID、settings 范围、`0|1` 约束。
    验收：每条检查各有一个「坏文件被拒」的用例，且至少一条用**真实导出的文件**做对照
    （证明合法文件不被误拒）。

A2. **`FetchError` 五阶段细分**（二.2）。按 HTTP / 解析 / schema / timeout / transport
    分开分类，401/403 专门归类。**不要**复活 `retryable` 字段（理由见二.2 注）。
    验收：能指出某个此前被归为 `network` 的真实场景，改后归到正确 code。

A3. **`declarativeNetRequest.ts` 加测试**（二.3）。186 行的防盗链规则目前零自动化验证，
    而它一旦静默失效，表现是「此前能显示的图片变成占位」。规则集合是纯数据，可直测。
    验收：断言规则数量、`initiatorDomains` 限定为扩展自身、`sub_frame` 不在其中
    （与 fix queue #5 的三条约束一一对应）。

A4. **规则 8 台账收敛**（二.4）。8 处直连里，优先处理有明确低风险改法的
    （`useMediaMaintenance` 的两个函数可直接经 `postService` 暴露）。
    新增 service 方法时**同一提交内**更新 `AGENTS.md` 规则 8 的表。

A5. **`AGENTS.md` 减负收尾**（AUDIT P2-17b 的剩余部分）。已完成的：16 条规则带附录指针、
    Non-goals 已收成 6 行指针、`Fix queue` 台账已移入 `AGENTS_CASES.md`、
    `PRODUCT_DECISIONS.md` 已承接产品决定。**剩余**：规则 9（51 行）、28（51 行）、30（55 行）
    仍超出「每条 2–8 行」的目标——把事故叙述搬进 `AGENTS_CASES.md`，正文只留约束。
    验收：三条规则各自 ≤ 8 行且语义不丢；`AGENTS_CASES.md` 锚点可达。

#### 队列 B — 有前置条件

B1. **Twitter 真实 payload fixture**（二.3，最高价值的证据项）。
    前置：需要一次真机会话抓到 x.com 的 GraphQL 响应（可用 omp relay 借用户已登录的浏览器，
    只读、不导航、不点击；bilibili / xiaohongshu 的 fixture 即用此法取得，见
    `docs/archive/2026-09-closures.md` 的 B33）。
    验收：至少一条 fixture **逐字**取自真实载荷，与手工构造的并存；
    `twitter.emptyTimeline`（31 例）与 `twitterTimeline.injected`（12 例）保持通过。

B2. **weibo / pixiv / fantia 的解析测试**（二.3）。
    前置：按 bilibili / xiaohongshu 的做法先建按解析路径裁剪的 fixture，再把解析段提纯为纯函数
    （那两次的先例：提纯前后测试全绿即为等价性证据）。
    验收：三个平台各有解析测试；提纯若做，必须有等价性证据。

B3. **`autoSync.ts` / `platformAuth.ts` 的测试**（二.3）。
    前置：两者都直接依赖 `chrome.*`，需要先确定 mock 边界（E2E 已覆盖 alarm 的端到端行为，
    所以这里的目标是**单元级**的判据而非再验一遍端到端）。

B4. **悬停预取**——**已完成（2026-09-12）**，`usePlatformPrefetch.ts` + 侧栏 `@mouseenter`，
    5 例测试钉住边界（每平台一次、磁盘缓存未绑定即跳过、被新悬停取代即停止、逐条失败不回滚）。
    留此条目仅为避免重复提议。

#### 队列 C — 需要用户决定

C1. **待办是否迁 GitHub Issues**（AUDIT P2-17a）。**未决定**。
    PR-first 工作流已否决，但那否决的是 **PR 流程**，与「待办放哪」是两件事。
    属**流程变更**（本仓库现为 master-first、文档承载待办），需用户单独拍板。
    当前事实：待办入口是本文 §四.P8。

C2. **P6 整体 UI 风格重设计**——用户明确「当前不排期」，见上。

#### 仍不可验（环境限制，别浪费时间重试）

- **alarm 跨浏览器重启的长期行为**：CDP `loadUnpacked` 加载的扩展不跨重启留存，
  重启后重新加载等同全新安装。要验只能在真实安装的扩展上做。
- **Twitter / 抖音路径的固有脆弱性**（二.6 / 二.7）：属外部依赖，本地重构无法消除。

#### 已知陷阱（踩过，省你时间）

- 扩展 E2E 必须带 `--enable-unsafe-extension-debugging`，否则 `Extensions.loadUnpacked`
  报 `Method not available`（规则 28）。
- 导入成功路径的 `alert()` **阻塞渲染进程**，连带 `Runtime.evaluate` / `Page.enable` 永久挂起；
  须在执行动作前启用 Page 域并应答 `Page.javascriptDialogOpening`。
- 视觉验证只开独立 profile 的专用实例，绝不驱动用户正在浏览的窗口（规则 25）。
  **`--window-position=-2400,-2400` 不够**——窗口仍会出现在任务栏，要**最小化**（规则 28）。
- jsdom 不做布局：几何问题用规则 30 的单文件 HTML 打包在真实排版引擎里量。
- 脚本化改写必须断言命中数，否则「匹配不到」会产出假绿（规则 26）。
- 本仓库 `core.autocrlf=true`：签入为 LF，工作区可能是 CRLF，多行锚点会匹配不到。
- **代理派活**：穷尽式核查用 `reviewer` / `task`，**不是** `scout`；多代理写同一文件必须先
  经 `hub` 协调边界（规则 31，含 2026-09-12 的复发案例）。
