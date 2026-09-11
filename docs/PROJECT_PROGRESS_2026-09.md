# Chorus 项目进步与剩余不足 — 2026-09

> 本文档只留**当前状态与待办**：现状速览 / 二（仍存在的不足）/ 三（成熟度）/ 四（P0–P8）。
> 原「结论」、一（第 1–33 批的逐批叙述，共 45 节）与「最终评价」已移入
> [docs/archive/2026-09-batches.md](archive/2026-09-batches.md)——**冻结的历史**，不与代码同步，
> 其中的行数、测试计数与提交号都只是当时的快照。
>
> **目录**
> - [二、仍然存在的不足](#二仍然存在的不足) — 未关闭项与已关闭项的原文留存
> - [三、当前成熟度判断](#三当前成熟度判断)
> - [四、后续优先级](#四后续优先级) — P0–P6 状态、**P7 待浏览器验证清单**、**P8 交接队列（待办唯一入口）**
>
> 历史：[第 1–33 批批次叙述 / 阶段结论 / 最终评价](archive/2026-09-batches.md) ·
> 规则与案例：[../AGENTS.md](../AGENTS.md) / [AGENTS_CASES.md](AGENTS_CASES.md)

## 现状速览（截至 2026-09-11）

> **接手本项目**：待办入口是[四.P8 交接队列](#p8交接队列2026-09-11-整理供新会话接手)——
> 基线、已确认无需重验的项、四个队列与已知陷阱都在那一节。本节只描述状态。

> 本节只写**现在**是什么状态；下面「结论」及后续章节按时间滚动追加，保留当时的判断与原文。
> 两者若冲突，以本节与源码为准。

**质量门禁（2026-09-11 实测）**

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npm run typecheck` | `tsc`（TS7 原生）→ `vue-tsc`，含 `strictTemplates`；0 错误 |
| 静态检查 | `npm run lint` | ESLint flat config；0 问题 |
| 回归测试 | `npm test` | **495 通过 / 6 跳过，42 个文件** |
| 构建 | `npm run build` | `.output/chrome-mv3/` |
| 打包 | `npm run zip` | `chorusdesk-1.0.0-chrome.zip` |

CI（`.github/workflows/ci.yml`）在每次 push/PR 上跑 typecheck + lint + vitest + build；
打 `vX.Y.Z` 标签触发 `release.yml`（复跑门禁 + 校验标签与版本号一致 + 生成 Release 资源）。

**成熟度**：可作为日常使用的工具，且已由真机反馈驱动了 30 余轮修复（批次叙述见
[批次记录](archive/2026-09-batches.md)）。可靠性主要受**外部平台**
约束（Twitter 网页接口变更、抖音必须真实页面渲染），不取决于本地代码质量。

**当前开放的问题**

- **结构性不足**：见[二、仍然存在的不足](#二仍然存在的不足) —— `FetchError` 分类精度、
  备份校验未达完整 schema、新增平台的配置点仍多、Twitter/抖音路径的固有脆弱性。
- **已知技术债**：`CreatorsView.vue` 已由 1481 行收敛到 617 行（四.P4 四刀，三套主模板已移出，
  **行数与进展见四.P4**）；剩余为非阻塞的进一步收敛。三个迁移期兼容桶
  （`src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts`）与零引用脚手架
  `components/DashboardSection.vue` **已于 2026-09-11 删除**。
- **待真机确认**：见[四.P7](#四后续优先级) —— 仅剩「alarm 跨浏览器重启的长期行为」
  （同 profile 内的备份导出导入往返已于 2026-09-11 实测通过，见四.P7 补记）。
- **未排期**：四.P6 整体 UI 风格重设计。

**已决的非目标（不要再提议）**

见 `AGENTS.md` 的 *Non-goals* 一节：RSS 卡片不显示配图；视频缩略图不加角标/播放图标
（页脚「视频动态」已是静态标识）。

**验证方法上的三条硬约束**

- 真实浏览器验证**只开独立 profile 的专用实例**，绝不驱动用户正在浏览的窗口（`AGENTS.md` 规则 25）。
- **完整扩展 E2E 可用**：`--load-extension` 在 Chrome 152 被忽略，但
  `--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` 可以加载构建产物，
  并在扩展自己的 Service Worker / 页面里取证（存储、alarm、消息、真实点击与文件导入）。
  见 `AGENTS.md` 规则 28 与四.P7 补记。
- 该 E2E **不跨浏览器重启留存**（重启后重新加载等于全新安装），故跨重启行为仍需真实安装验证。
- 组件级布局验证走单文件 HTML 打包（`AGENTS.md` 规则 30），jsdom 不做布局。

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
> **补充（2026-09-10，第三批）**：随后按界面逐项走查仍发现 14 项 UI/交互问题（见[批次记录 §一.13](archive/2026-09-batches.md)），
> 说明「无影响使用的异常」只覆盖日常路径，不能替代逐项走查。备份全量导出导入与 alarm
> 跨浏览器重启的长期行为仍未专项演练。

### 2. `CreatorsView.vue` 仍然较大 — 已大幅收敛（2026-09-11，四.P4）

文件从 1420 行缩减到约 1100 行，主要重复块已提取，但仍同时承担：

（**行数与进展只记在四.P4**，本节不重复数字——两处各记一个数字正是本文档此前失准的原因。
四.P4 的四刀已把三套主模板、工具条与筛选/排序状态全部移出，该文件现为「目录控制器」。）

- 搜索与排序。
- 标签三态过滤。
- 批量模式。
- masonry 分列。
- Grid/List/Detailed 三种主模板。
- 同步状态聚合。

拆分方向（前两项与三项主模板均已完成，见四.P4）：

- ~~`useCreatorDirectoryFilters`~~ — 已完成（切片 1）
- ~~`CreatorDirectoryToolbar`~~ — 已完成（切片 1）
- ~~`CreatorListView`~~ — 已完成（切片 2）
- ~~`CreatorGridView`~~ — 已完成（切片 3）
- ~~`CreatorDetailedView`~~ — 已完成（切片 4）
- 交互状态（展开/勾选/拖拽/头像失败 + masonry 分列）可再进一个 composable；两类空态可各成一个组件

### 3. UI 拆分可能存在轻微视觉差异

需要人工确认：

- detailed 标签区域位置。
- ~~compact ChannelRow 的平台辨识度~~ — 已解决（第十六批在账号行加入平台色点与平台名，
  因为只显示角色时同名跨平台账号无法区分）。
- detailed 账号头像 URL 处理。
- detailed header 的作品数位置。
- flex wrapping 和局部间距。
- 新增待确认：账号行加入平台名后，紧凑网格视图是否变得拥挤或换行（[批次记录 §一.16](archive/2026-09-batches.md)）。

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

新增平台需要同步修改 adapter、registry、platform metadata、URL parser、cookie auth 与 DNR。
（2026-09-10 更新：**host allowlist / manifest permission / proxy-image policy 三点已合并**——
`PLATFORM_HOSTS` 是唯一来源，manifest 由其派生，代理白名单与 Referer 同样读它，
故新增平台在域名这一侧只需改一处，见二.9。）

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

### 9. host allowlist、manifest permission 和 proxy policy 仍是多个来源 — 已关闭（2026-09-10，第四批）

原记录：`hosts.ts`、`wxt.config.ts` 和 proxy-image policy 尚未由同一静态定义生成。

现状：`PLATFORM_HOSTS` 已是唯一来源，manifest 由 `platformHostMatchPatterns()` **派生**，
`proxyImage` 的自有正则与 `includes()` 判 Referer 已改为读取 `isPlatformHost()` 与
`MEDIA_REFERER_BY_DOMAIN`；`tests/hosts.singleSource.test.ts` 断言派生关系、代理无私自清单、
Referer 键必须是已声明平台域名。详见[批次记录 §一.14](archive/2026-09-batches.md)。

原记录列出的三项潜在问题中，第一项已**实际发生**并修复：代理白名单不含任何抖音域名，
而 PLATFORMS 文档与 P0 清单均宣称抖音封面「走 Background 图片代理」——该路径从未可执行。
以下原文留存备查：

- runtime 允许但 manifest 无权限。
- manifest 有权限但 credential policy 未同步。
- fetch 可用但图片代理拒绝新 CDN。

### 10. 权限仍可能偏宽 — 已收窄并经部分实测（2026-09-10，第四/十三批）

原记录：使用 cookies、tabs、activeTab、scripting、declarativeNetRequest 与多个 host permissions。

已完成（详见[批次记录 §一.14](archive/2026-09-batches.md)）：

- **移除 `tabs`**：平台标签页 URL 由 host 权限覆盖，Popup 当前页由 `activeTab` 覆盖。
- **`declarativeNetRequestWithHostAccess`**：与规则的实际作用域一致。
- **RSS 走 `optional_host_permissions`**：安装时不授予任何站点，同步时按站点单独询问。
- **version 不再硬编码**，manifest 由 `package.json` 派生。

实测结论（用户验证，2026-09-10）：**微博 / 小红书图片经 DNR 正常加载**，即
`declarativeNetRequestWithHostAccess` 仍然命中防盗链规则（四.P7 第 2 项通过）。

~~仍待确认：**移除 `tabs` 后 `tabs.query` 能否读到平台标签页 URL**（四.P7 第 1 项，风险最高的一项）~~
——**2026-09-11 已在真实 Chrome 中实测通过**（独立调试 profile 于该扩展的 Service Worker 内取证，
`url` 对 host 权限覆盖的平台域名可读、对未授权域名不可读），抖音与 Twitter 的标签页定位不受影响。
详见四.P7。

尚未做的仍是审核层面：如何进一步降低 Chrome Web Store 安装提示与审核风险。

### 11. ESLint — 已引入（2026-09-10，见[批次记录 §一.12](archive/2026-09-batches.md) 与四.P5）

原记录：CI 无法系统约束 floating Promise、新增 `any`、层次违规、死代码和高复杂度条件。
现状：最小 flat config 已上线并接入 CI（`npm run lint`），首轮 77 处错误全修零抑制。
type-aware 规则与格式化规则有意未启用（见 `eslint.config.js` 头注释），后续可作为增量项。
以下原文留存备查：

- floating Promise。
- 新增 `any`。
- 层次违规。
- 死代码。
- 高复杂度条件。

### 12. Dexie migration — 已进入永久 CI（2026-09-10，见[批次记录 §一.12](archive/2026-09-batches.md) 与四.P2）

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

- **同步前置条件**（原文为「需要用户打开目标创作者主页并保持标签页开启」，2026-09-10 第十一批更正）：
  实际前提只是**存在任意一个 douyin.com 标签页**——扩展会把找到的标签页导航到目标创作者主页再采集，
  创作者本人的页面从来不是必要条件；第十一批起若一个抖音页面都没有，扩展会自行开一个后台标签页
  并在采集后关闭，因此手动同步已无任何前置条件。报错文案此前写成「请打开该创作者主页」，夸大了要求，
  已一并更正。
- **DOM 结构耦合**：页面改版（滚动容器类名、网格节点、封面/标题选择器变化）会直接破坏采集器，且只能在真实页面中发现——fixtures 无法预警。
- **短缺不等于被截断**：主页标示的作品数**包含作者隐藏的作品**，所以「加载数 < 标示数」是常态，
  不能据此断言「未登录被截断」。早期文档把一次「18 / 29」的实测当作截断证据，该推断**已撤回**
  （AGENTS.md 规则 10）。采集器的应对是保持可续挖、绝不写「已到底」——证据不足时宣称到底会永久
  封死更早的作品，而多发一次滚动只多花一次请求。
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
10. 抖音：触发同步即可（无需预先打开任何抖音页面，2026-09-10 第十一批起扩展会自行开页），
    验证注入采集、昵称/头像恢复（含 popup 快速关注）、封面加载、历史回溯的滚动容器驱动与
    「X / Y 篇」截断提示。

### P1：真实 Chrome 走查修复 — 已完成（2026-09-10）

三轮走查共 14 项发现（`8465887` / `e2d9923` / `d4e031e`），全部修复，明细见[批次记录 §一.13](archive/2026-09-batches.md)。
其中 3 项为真实缺陷（错字、登录检测无反馈、账号数切换样式回退），其余为交互与信息密度
改进；顺带收敛了三处常量重复与三处原生控件风格分裂。

> 历史快照（2026-09-10 当日）：工作区干净；typecheck、lint、129 项测试通过（16 个文件中
> 15 个执行、1 个 skip，另有 6 个用例 skip）、production build 全部通过；master 领先 origin
> 3 个提交。**以下计数均已过期**，当前值见文首第十七批记录与 P7。

### P2：永久 Dexie migration 测试 — 已完成（2026-09-10）

`tests/dexie.migration.test.ts`（3 用例，fake-indexeddb 真实升级链）已随 CI 运行，
v3→v4 布尔转 `0|1` 契约（含墓碑快照与索引命中）被永久钉死。详见[批次记录 §一.12](archive/2026-09-batches.md)。

### P3：收窄运行时敏感状态 — 已作废（2026-09-10）

Rplay 平台整体移除（`389b007`）后，`rplay_auth_token` 路径不复存在，
token 在 `onInstalled` 时被幂等清除，本项无对象。

### P4：继续拆分 CreatorsView — 切片 1–4 已完成（2026-09-11），三套主模板全部提取

按 toolbar、grid、list 和 detailed 布局继续拆分。

**验收方式（四刀共用）**：`e2e/creators-render.mjs` 在**真实 Chrome** 里加载构建产物、
经真实导入路径播种固定 fixture（4 创作者 / 6 账号 / 6 动态），逐步驱动交互并记录创作者区块的
`outerHTML`，改动前后各拍一次再 `diff`。每步带后置条件断言（「N/M 位创作者」计数、`aria-sort`、
全选计数、拖拽后的落库顺序），防止「点了但没点到」让对比失去意义。

| 切片 | 移出到 | 视图行数 | 对比结果 |
|---|---|---|---|
| 1 | `composables/useCreatorDirectoryFilters.ts`（310）+ `components/creator/CreatorDirectoryToolbar.vue`（355） | 1481 → 1060 | 三视图模板逐字节相同；唯一差异是搜索框多一个 `value` 属性（`v-model` 只写 DOM property，`:value` 另写 attribute） |
| 2 | `components/creator/CreatorListView.vue`（415）+ 共享契约 `types/creatorDirectory.ts` | 1060 → 814 | **22 步全部逐字节相同**（740710 B） |
| 3 | `components/creator/CreatorGridView.vue`（153）；契约抽成 `CreatorDirectoryPresentation` / `CreatorDirectoryInteraction` / `CreatorCardViewContext` | 814 → 751 | **22 步全部逐字节相同**（740710 B） |
| 4 | `components/creator/CreatorDetailedView.vue`（158） | 751 → **617** | **22 步全部逐字节相同**（740710 B） |

切片 1：筛选与排序状态进 composable（依赖以 getter 注入，否则 computed 失去响应式追踪）；
标题行 + 视图切换 + 批量开关 + 筛选栏 + 批量工具条进工具条组件。
切片 2：紧凑列表（5 个可排序表头 + 行内展开区 + 批量勾选列 + 手动排序拖拽）整块移出，
**不持有状态**；三处内联的拖拽处理收成具名回调后经上下文传入，拖拽链路由探针端到端验证
（DOM 顺序 + IndexedDB 里的 `sortOrder` 都变）。
切片 3：网格整块移出；`types/creatorDirectory.ts` 收拢三套视图共用的契约——`CreatorSortKey`
从 composable 迁来（类型属于使用它的契约，且不再让 `types/` 依赖 `composables/`），
`CreatorDirectoryPresentation`（channels/postCountMap/分组账号/同步聚合/相对时间/主头像/
头像失败）与 `CreatorDirectoryInteraction`（批量勾选/展开/拖拽/标签三态）由各视图 `extends`
组合，不再各自重declare 约 20 个字段；网格与详细卡片共用一个 `CreatorCardViewContext`，
不各起别名。视图构建一份 `cardViewContext` 再展开给两套卡片视图，因此「给一套加了辅助函数
忘了另一套」不可能发生。
切片 4：详细卡片移出（多一项本视图专属的 `failedAvatarUrls`，账号行靠它回退首字母）。

**现状**：三套主模板、工具条与筛选状态均已移出，`CreatorsView.vue` 剩 617 行，职责收敛为
「目录控制器」——视图模式与 localStorage、展开/勾选/拖拽/头像失败等交互状态、masonry 分列、
`cardViewContext`/`listContext` 的组装、两类空态、以及向上抛出的 emits。

**还可继续**（非阻塞，尚未做）：交互状态（展开/勾选/拖拽/头像失败 + 分列）可再进一个
composable，两类空态可各成一个组件。行数记录只保留在本文，`二.2` 不重复数字。

### P5：单独引入 ESLint — 已完成（2026-09-10）

最小 flat config 上线并接入 CI（`npm run lint`），TS7 经官方双别名与 lint 工具链共存，
首轮 77 错误全修零抑制（含 1 个真回归与 1 个真 bug）。详见[批次记录 §一.12](archive/2026-09-batches.md)。

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

### P7：真实浏览器行为验证（持续更新，2026-09-10；2026-09-11 更新）

以下改动**只在编译与测试层验证过**，其正确性取决于真实浏览器语义，需要人工确认。
（本清单随每批新增项滚动更新；已确认的项标注结果并保留记录。）

**已通过**

- ✅ **`declarativeNetRequestWithHostAccess` 仍命中防盗链规则**（第四批项）：用户实测
  微博 / 小红书图片正常加载。若不命中，表现为此前能显示的图片变成防盗链占位。
- ✅ **RSS 站点授权弹窗**（第四批项）：日志 `hostAccess: RSS 站点授权已确认（1 个源）`
  确认按站点授权生效，且 `bgFetch: daily.juya.uk → 凭据：omit` 说明非平台域名不带凭据。
- ✅ **开发者日志面板**（第四批项）：面板、筛选、详细模式、跨上下文（`sw` 与 `page` 记录
  同时可见）均已在用户日常排查中实际使用。
- ✅ **抖音临时页自动关闭**（第十一/十四批项）：日志反复出现 `已关闭抖音临时页（tab …）`。
- ✅ **移除 `tabs` 后 `tabs.query` 仍能读到平台标签页 URL**（第四批项，原「风险最高」——
  2026-09-11 独立 CDP 探针实测）。方法：一次性调试 profile 加载 `.output/chrome-mv3`，
  在该扩展自己的 Service Worker 里调用 `chrome.tabs.query`，不再依赖推断。
  结果：`permissions` 确无 `tabs` 的情况下，`query({})` 对 `bilibili.com`、`x.com`
  返回了 `url` 与 `title`，对无 host 权限的 `example.com` 返回 `undefined`；
  `query({url: ['*://*.x.com/*', '*://*.twitter.com/*']})` 在打开 x.com 后命中 1 项。
  即：平台标签页 URL 由 host 权限覆盖这一推断成立（Chrome 官方文档亦如此规定：
  host permissions 允许读取 `url`/`pendingUrl`/`title`/`favIconUrl`，
  且 `queryInfo.url` 过滤在无 `tabs` 权限时由 host 权限接管），
  抖音 / Twitter 的标签页定位与 `platformAuth` 的 Twitter 兜底均不受影响。
  附带观察到一条非缺陷事实：**扩展自己的页面 URL 也读不到**（`dashboard.html` 的
  `url` 为 `undefined`）——现有代码不读自身页面 URL（Popup 探测读的是活动标签页，
  由 `activeTab` 覆盖），故无影响；若将来要读，需重新评估。
- ✅ **「展开全文」的溢出门控与阅读视图**（第十五/十六批项的非 RSS 一路——
  2026-09-11 同一探针实测）。注入 420 字探针动态后：正文实测 `clientHeight 78 /
  scrollHeight 332`（clamp 生效）→ 按钮出现；6 字探针卡片 `clientHeight 20 /
  scrollHeight 20` → 按钮不出现；点击后进入 `role="dialog"` + `aria-modal="true"`
  的阅读视图，全文可见；Escape 关闭且 body 滚动锁定恢复为 `visible`。
  即：`display:-webkit-box` 下 `scrollHeight` 塌缩导致的「永不判溢出」确已修复。

**待确认**

1. **RSS 卡片与阅读视图**（第十五/十七/十八/十九批项）。**根因链已全部定位并修复**：
   适配器读 `<description>`（源自己的摘要，实测 359 字、结尾 `…`，与用户截图逐字一致），
   全文在 `<content:encoded>`（31144 字）；且正文被扁平化为纯文本，导致文章结构丢失
   （图片堆到最下方、标题与段落无分别）。
   现：`content:encoded` → `content` → `description` 回退取值；上限 4000 → 20000；
   **新增 `Post.contentHtml`**（净化后的文章 HTML）+ `.article-body` 标签级排版；
   图片代理不再拒绝非平台域名（`assets.juya.uk` 等源自有图床现可加载）。
   已在本地用真实源 + 构建产物渲染复核（见[批次记录 §一.30](archive/2026-09-batches.md)）。
   （卡片配图是否显示已按用户决定**不再跟踪**，见下方第 4 项。）
2. **抖音同步不再触发风控**（第十八/十九/二十批项）——**已由 2026-09-11 日志确认**：
   上一轮失败的两个频道（`uimi`、`可尔必思好好喝`）本轮全部成功，`平台原始 10 条`；
   `作品网格在等待时间内未渲染` 与 `Frame with ID 0 was removed` 均 **0 次**；
   抖音两次请求之间实测 **15.5s**（下限 15s，节流生效）。此项已关闭。
   仍需观察的是**长期**是否复发——风控与「本次已被标记」的账号状态有关，冷却是为此设计的。
3. **抖音同步是否完全不扰动用户标签页**（第十六批项）——**已确认**：
   `标签页扫描：共 46 个，抖音 1 个，其中 URL 可读 1 个`，且连续出现
   `已关闭抖音临时页（tab …）`；用户已打开的抖音页未被导航。此项已关闭。
4. ~~**RSS 行内图片**（第十九/二十批项）~~ —— **按用户决定关闭，不作为目标**
   （2026-09-11：「rss不需要这个」）。适配器侧的部分本就已生效（单卡片最大探测项数
   由 23 降至 4）。**卡片是否显示配图不再是待办项，后续修改不再提出。**
5. **紧凑列表表头与内容对齐**（第二十批项）：已改为单一左对齐分组，并统一 `操作` 列内边距。
   **需要目视确认**——对齐依赖真实排版引擎，jsdom 不做布局，无法在本机断言。
   > **已关闭（第二十七批，2026-09-11）**：前两次修改都只调整了「已绑平台账号」单元格
   > *内部*的对齐，而按钮的 x 取决于该行徽章数量，因此不可能修好。已按调研模式把展开控件
   > 改为**行首 chevron**（x 恒为 31，与徽章数无关）并删除自造的「明细」列。
   > 在**隔离 Chrome**（非用户浏览器）中用真实样式表实测 + 目视双重确认。
6. **推特正文尾部的 t.co 链接**（第二十二/二十三批项）——**已确认**（用户反馈「转发不带了」）：
   原创按 payload 声明的实体删除；**转发**补齐媒体链（原先两条分支取不到 `.media`，
   导致媒体与追加链接候选都缺失），并加一处「哪里都没声明」时的窄兜底；
   **存量行由 Dexie v5 迁移清理**（普通同步够不着旧行：只返回最新约 10 条，强制刷新也一样）。
   此项已关闭。**作者自己发的链接会保留**（含正文中间位置的）——这是有意为之。
7. **抖音采集**（第十八/十九/二十/二十三/二十四/二十六批项）：真因已定位并修复——
   **重试按「次数」限制是错的**。探针在冷标签页上会持续「注入未返回结果」（每次约 1s），
   3 次上限 = 1.6s 就放弃，而被等待的页面**约 10s 才水合**；那 10s 预算一次都没用上。
   现已改为 **20s 时间期限**（每次尝试的预算不变，只改尝试次数）。
   待确认：重载后 `uimi` 等频道是否恢复正常；日志中 `网格探针未能完成，重试`
   若出现多次后**采集成功**，即为本修复在起作用。
   另：H1（读内嵌数据绕开渲染）**已实测否定** —— 桌面页的 `RENDER_DATA` 只有应用配置，
   见 `docs/DOUYIN_RESEARCH_2026-09.md` §五。
8. **开发者日志的信噪比**（第二十一批项）——**已确认**：`磁盘探测` 已按爆发汇总。
9. **图片代理 403**：`assets.juya.uk` 仍可能返回 403（CDN 侧 183/183 均为 200，
   故与当前的抓取风控同源）。冷却机制生效后再观察。

**长期项**（与既有遗留合并）：备份全量导入导出（二.1 注记）、alarm 跨浏览器重启的长期行为。

### P7 补记：独立 profile 的全扩展 E2E（2026-09-11）

发现 `--load-extension` 在 Chrome 152 被忽略（见 AGENTS.md 规则 28）之后，项目一直把
「完整扩展 E2E 不可用」当作既定天花板。本次复核推翻了其中一半：
**`--enable-unsafe-extension-debugging` + CDP `Extensions.loadUnpacked` 可以完整加载构建产物**，
并能在该扩展自己的 Service Worker 与页面里取证。规则 28 已按实测改写，此处记录由此完成的
三项验证（均为真实构建产物、独立 profile、测毕删除）：

| 待验项 | 方法 | 结果 |
|---|---|---|
| 备份导出产生真实文件 | 设下载目录后点「下载 JSON 备份」 | `creator-feed-hub-backup-*.json`，1204 B，`version: '1.0'`，四个 section 齐全 |
| 备份导入还原数据 | 先删三张表的探针行，再用 `DOM.setFileInputFiles` 交回导出文件 | 创作者/频道/动态全部还原，正文与收藏位保持 |
| **打开 popup 不重置 alarm**（P0 清单第 9 项） | 连开 3 次 popup，前后各读 `alarms.getAll()` | 4 次 `scheduledTime` 完全一致（Δ 0 ms） |

因此：**P0 清单第 9 项在真实扩展环境中确认通过**（此前只有代码层推断）；
**备份全量导入导出**在「本机同 profile」范围内验证通过，长期项收缩为
「跨浏览器重启后的行为」一项。

**仍不可验的具体原因**（而非笼统的「无法验证」）：`Extensions.loadUnpacked` 加载的扩展
**不跨浏览器重启留存**——重启后重新加载等同于一次全新安装，alarm 是否存在、
`onInstalled` 何时触发都被重建而非延续，故跨重启结论无法从此环境得出。

**一处 harness 陷阱**（供后续复跑者）：导入成功路径调用 `alert()`，它会阻塞渲染进程主线程，
连带令 `Runtime.evaluate` 与 `Page.enable` 永久挂起（表现为「页面卡死」而非产品缺陷）。
需在执行动作**之前**启用 Page 域并应答 `Page.javascriptDialogOpening`。

### P8：交接队列（2026-09-11 整理，供新会话接手）

> 本节是**唯一**的待办入口。上面的批次记录是历史，不要从那里推断「现在要做什么」。

#### 交接基线（接手前先核对）

- **代码基线**：`master`，工作区干净。接手第一件事：`git status -sb` 与
  `git log origin/master..master --oneline` 核对本地领先了哪些提交，需要时推送
  （推送属需授权操作）。整理本次交接时领先 **3** 个提交：
  `2ed4ba7`（删除三个死兼容桶 + 零引用脚手架）、`c82fc95`（修正规则 28：CDP 可加载
  扩展，并补两项 P7 证据），以及本节所在的交接整理提交（含抖音文档纠错）。
- **门禁全绿（2026-09-11 实测）**：`npm run typecheck`（tsc + vue-tsc strictTemplates）、
  `npm run lint`、`npm test`（**495 通过 / 6 跳过 / 42 文件**）、`npm run build`。
- **读序**：`AGENTS.md`（31 条规则 + Non-goals，**必读**）→ `docs/ARCHITECTURE.md`（当前事实
  与契约）→ 本文件「现状速览」→ 本节。`docs/DEVELOPMENT.md` 是改动流程手册。
- **历史材料**：`docs/DOUYIN_RESEARCH_2026-09.md`（抖音为何不能走 API）、
  `docs/PHASE_REPORT_2026-09.md`、`docs/REVIEW_2026-09.md`。

#### 不要重做的验证（已通过，勿重复探测）

见四.P7 及 P7 补记，其中已在**真实宿主**中确认的：

- `tabs.query` 在无 `tabs` 权限下仍可读平台标签页 URL（抖音/Twitter 定位依赖它）；
- 备份导出→删库→导入的完整往返（同 profile 内）；
- 反复打开 popup **不**重置 alarm 倒计时（`scheduledTime` 四次读数 Δ 0 ms）；
- `declarativeNetRequestWithHostAccess` 仍命中防盗链、RSS 按站点授权弹窗真实出现；
- 「展开全文」的溢出门控与阅读视图（含 Escape 与滚动锁）；
- 抖音临时页自动关闭、抖音不扰动用户已开标签页。

#### 队列 A — 立即可做，不需要用户输入（建议按序）

1. ~~**文档收口（收益最大，先做）**~~ —— **已完成（2026-09-11）**（行数为拆分当次实测）：
   `docs/PROJECT_PROGRESS_2026-09.md` 2660 → 555 行，只留现状速览 / 二 / 三 / 四；
   原「结论 + 一（45 节，含第 1–33 批）+ 最终评价」**逐字**移入
   `docs/archive/2026-09-batches.md`（2125 行，冻结）；正文中 10 处「一.x」引用改指归档。
   `AGENTS.md` 973 → 778 行：12 条长案例（16/17/19/21/23/24/26/27/28/29/30/31）压成
   「规则 + 规范性约束 + 附录指针」，拆分前原文逐字保存在 `docs/AGENTS_CASES.md`
   （554 行）；规则编号未变。拆分时一并修掉过期事实：`CreatorsView` 行数口径
   （1409 → 见四.P4）、ARCHITECTURE 权限清单（仍写 `tabs`/`declarativeNetRequest`）、
   ARCHITECTURE 的兼容桶与 `§2.1` 表述、DEVELOPMENT 的权限红线（同样写着 `tabs`）
   与「无法用命令行加载未打包扩展」。另撤回二.13 与 `douyin.ts` 注释里仍在断言
   「未登录被截断」的推断（AGENTS.md 规则 10 早已撤回）。
   验收方式：逐行核对「归档 == 原文分段」「未拆分规则逐字未变」「原文件所有 MUST/NEVER
   句子在新 `AGENTS.md` ∪ 附录中存在」，全仓相对链接与标题锚点可达（15 个 md、30 个锚点），
   外加 eslint / 495 项测试 / `tsc`+`vue-tsc` 三门禁复跑。
   理由（原文）：本次会话两次读到过期数字（`CreatorsView` 记 1409 实为 1481、Dexie schema
   只列到 v3 实为 1–5）都是穿越长文造成的。遵守手册第 14 节：文档保存长期规则、当前状态
   与代码入口，不复制所有历史日志。
2. ~~**把 2026-09-11 的 E2E 探针固化成脚本**~~ —— **已完成（2026-09-11）**：
   产出 `e2e/release-gate.mjs`（`npm run e2e`），接进 `release.yml`（在 `npm run zip` 之后、
   发布之前；CI 无显示环境用 `xvfb-run -a`）。它自己启动独立 profile 的 Chrome
   （`--remote-debugging-port=0` → 读 `DevToolsActivePort`）、自己 `Extensions.loadUnpacked`
   加载 `.output/chrome-mv3`、用真实鼠标事件点击、自己收尾删 profile，共 15 项检查：
   产物版本与 `package.json` 一致性、扩展页挂载、备份导出（真实下载）→ 导入导出逐字节等价 →
   清库 → 真实 file input 导回并比对行与设置、以及 alarm 三段（拨开关建立 → 连开 3 次 popup
   → **`ServiceWorker.stopWorker` 冷停 worker 再唤醒** → 关开关清除），三次 `scheduledTime`
   读数 Δ 0 ms。
   **它跑的第一件事就抓到一个真缺陷**（详见下方「本轮发现」）。
   变异验证（规则 26）：把 `SettingsView` 的通知改回「先通知后落库」→ `alarm.enable-auto-sync`
   失败且退出码 1；把 `createBackup` 的 posts 换成 `[]` → `backup.import-export-lossless`
   与 `backup.reimport-restores` 失败；恢复后两次全绿。
   未验证项：`release.yml` 的 Linux/Xvfb 路径本机无法跑（Windows 上验证的是同一脚本的
   Chrome/CDP 部分）；`ServiceWorker` 域不可用时该步会记 `skip` 并在末尾列出原因，不会算通过。

#### 本轮发现（已修）

- **自动同步开关的通知早于落库**（提交 `de90894`）：`SettingsView.updateBooleanSetting`
  先 `void onUpdateSettings(...)` 再 `onNotifyAutoSyncChanged()`，而 worker 的
  `setupAutoSync` 读的是**已存**的设置，于是读到旧值 `false`、走 `else` 分支
  **把用户刚打开的 alarm 清掉了**，直到下一次 worker 启动才补建。现象是「开关好像过一会儿才生效」，
  所以一直没人报。已改为 `await` 落库后再通知，写失败则只警告不通知；不变量补进
  `AGENTS.md` 规则 7。

3. **P4 `CreatorsView` 拆分** —— **四刀全部完成（2026-09-11）**：视图 **1481 → 617 行**，
   三套主模板（list / grid / detailed）、工具条与筛选排序状态均已移出，明细见四.P4。
   验收用 `e2e/creators-render.mjs`（真实 Chrome，22 步逐字节对比；切片 2/3/4 均**完全不同**，
   即每一步、每一字节都一致，含拖拽重排后的 DOM 与落库 `sortOrder`）。
   剩余为非阻塞的进一步收敛（交互状态进 composable、空态成组件），**不再作为队列项**，
   需要时从四.P4 取。
4. ~~**开成本账**（手册 13.3）：每平台两列——修复提交数 / 人工介入次数。先记一个月，
   用于决定小红书 / Twitter / 抖音这三条高 churn 路径是否降级为「尽力而为」。~~
   **已由 2026-09-11 的评估替代**（见 `docs/REVIEW_2026-09.md` 的 *Platform module maintainability*）：
   不再用「提交数 / 介入次数」这类代理指标（提交信息 grep 与实际改动不是一回事），
   改为直接量**平台模块本身好不好维护**——行数、最长函数、**有没有测试**。
   结论：**抖音不是风险，Twitter 才是**（全仓最长函数 + adapter 与 handler 双零测试 +
   外部契约已变过 5 次）；**RSS 是唯一用真实 fixture 直测 adapter 的平台，应作为模板**。
   原始前提「小红书是高 churn 路径」**数据不支持**：它零轮真机反馈，被改动过 10 次
   全部是批量重构带过。降级决策因此改为：先补 Twitter 测试，而不是降级任何平台。

#### 队列 B — 用户已批准或已列为不足，未实施

5. **悬停预取**（用户已认可方案）：鼠标停在左侧平台按钮上时预取该分组首屏约 36 条动态的
   图片（约 12 MB）。纯优化，排在缺陷修复之后。
6. **二.4 `FetchError` 精度与重试**：宽范围 `try/catch` 仍会把解析/认证问题归为 network；
   `retryable` 尚未驱动实际重试。需按 HTTP/解析/schema/timeout/transport 分开分类，
   再实现受限指数退避。
7. **二.5 备份校验不是完整 schema**：缺 timestamp 有限性、platform 枚举、跨表引用完整性、
   重复 ID、settings 字段范围、`isRead`/`isBookmarked` 必须为 `0|1` 等检查。
8. **`creatorTagFilter` 是筛管里的死状态**（P4 切片 1 顺手发现，未处理）：
   `useCreatorDirectoryFilters` 里保留着一个「单选标签」旧筛选（`creatorTagFilter`），
   仓库中唯一会写它的地方是空态按钮的「清除筛选」——也就是说它恒为 `'all'`，
   第 3.5 步过滤永不生效。删掉它会改变筛选管线的形状（虽然结果不变），
   所以没混进拆分提交。可作为一次独立的小清理（连同 `include`/`exclude` 已覆盖同等能力）。

#### 队列 B 补：2026-09-11 可维护性审计的产出（详见 `docs/REVIEW_2026-09.md`）

审计在 `4c89bb2` 上完成，五个只读切片并行，结论**未动手**。按「收益/风险」排序：

B9. ~~**`__END__` 游标终态语义有三份实现**（最高价值）~~ —— **已完成（2026-09-11，提交 `2f3fe7f`）**：
    新增 `src/sync/cursorState.ts` 独占该策略（哨兵值、哪些平台是「单发采集」因而其标记只是猜测、
    两个消费点各自要问的谓词、两种「这就是终点」的形态、以及用户文案）；`historySync` 与
    `channelSync` 只消费，**字面量 `'__END__'` 全仓只剩 1 处**（已 grep 核实）。
    两个既有回归测试（`douyin.endcursor` / `douyin.loophead`，4 用例）**未改动即通过**——它们就是规格。
    变异验证：清空 `SINGLE_SHOT_ACQUISITION`（一处、一文件）会让**两个**测试套件同时失败；
    改造前同样的改动要改两处 `platform !== 'douyin'`，漏一处正是 loophead 那次事故。
    未加新单测：谓词只能经这两个入口观察，直接调它属于测接线。原条目留存：
    `historySync.ts:16-46`（提前返回 +
   抖音特判）、`historySync.ts:110-115`（同一规则在挖矿循环里再写一遍，注释逐字重复）、
   `channelSync.ts:194,:394`（写入侧）。今天改「完成」的含义必须改三处。
B10. ~~**Twitter GraphQL `features` 在同一个文件里有两份逐字拷贝**~~ —— **已完成（2026-09-11，
    提交 `fca660a`）**，且**顺带挖出一个真缺陷**：驱动两份实现对比时发现，注入函数引用了模块作用域的
    `TWITTER_BEARER_TOKEN`，而 `chrome.scripting` 会 `toString()` 序列化函数——页面里直接
    `ReferenceError`，被它自己的 `try/catch` 吞成一条普通失败信息。**Twitter 的标签页路径在生产中
    一次都没跑成功过**，每次都静默落到直连兜底；`PLATFORMS.md` §2.2 那条「打开博主页面重试以复用
    会话」的建议因此从未生效。已修：bearer 与四组 features 全部经 `args` 传入，构建产物证实注入函数
    为 `func:async(e,t,n,r,i)=>`、从参数取值（token 在 bundle 里只剩 1 次）。同时补上该函数缺失的
    `catch`（`executeScript` 在帧消失时 reject，原本会穿过函数、跳过直连兜底）。
    新增 `tests/twitterTimeline.injected.test.ts`（8 用例）——**关键是它求值函数的「源码」（无闭包）
    并断言结果**，因为该函数会吞掉自己的异常，「没抛错」这种断言看不见这个 bug。原条目：
    `twitterTimeline.ts:76-141` 与 `:277-345`（后者是给注入脚本重新声明的一份）。
    X 改一个 flag 要改相隔 200 行的两处。
B11. **三态标签过滤器两份**：`useFeedFilters.ts:82-118` 与
    `useCreatorDirectoryFilters.ts:133-155` 逻辑逐字等价（两份原本就在同一个文件里，
    拆分只是让它可见）。可提 `createTagTriState()` 工厂 + 队列 B 第 8 条的 `selectedTag`/
    `creatorTagFilter` 一起清掉。
B11. ~~**三态标签过滤器两份**~~ —— **已完成（2026-09-11）**：新增
    `entrypoints/dashboard/composables/useTagFilterState.ts` 独占三态状态机、两个集合与
    **第三个重复**——同一个 include/exclude 谓词（原在 `useFeedFilters` 里两处、
    `useCreatorDirectoryFilters` 里一处，共三份）。顺带清掉两个死状态：`selectedTag`
    （全仓只有声明/重置/导出，无任何读取）与 `creatorTagFilter`（恒为 `'all'`，第 3.5 步
    过滤永不生效）。验证：写一次性脚本对 3 个旧实现做 149 项逐输入对比（8 种集合状态 ×
    9 种标签形状 × 2 个旧实现 + 状态机循环 4 步 + `clearTagFromFilters`）**全部等价**；
    另用 `e2e/creators-render.mjs` 在真实 Chrome 做 22 步逐字节对比，**全等**（738611 B）。
B12. ~~**`err instanceof Error ? err.message : String(err)` 至少三种写法**~~ ——
    **已完成（2026-09-11，提交 `c838a64`）**，验证：`src/utils/errorMessage.ts` 存在且被
    **16 个文件**引用，全仓该内联三元**零残留**。原条目：两个几乎一样的具名 `errorMessage()`
    （`bgFetch.ts:26`、`proxyImage.ts:21`）+ 约 10 处内联三元。
B13. ~~**死代码，约 30 行**~~ —— **已完成（2026-09-11，提交 `b0c3e19`）**：三个零引用导出已删并
    各自核实过全仓（含 tests/e2e）无引用。原条目：`postRepository.ts:63` `restoreDeletedPostId`（是 `restoreDeletedPost`
    的纯别名）、`:70` `restoreDeletedPostIds`（与在用的 `restoreAllDeletedPostIds` 同体，
    只差范围）、`registry.ts:34` `registerAdapter`（适配器实际静态注册）。
B14. ~~**`postService.deleteToRecycleBin` 为什么死，有明确原因**~~ —— **已完成（2026-09-11，提交 `b0c3e19`）**：
    修法比条目预估的大一档——`useDeletedPosts` 直连的是**七个**仓储函数（整个回收站生命周期），
    不是一处。已按规则 8 的口径把生命周期整体纳入 `postService`（新增 6 个方法），
    该组合式现只从 `src/application` 导入，规则 8 台账漂移的那一格已归位。原条目：`useDeletedPosts.ts:6` 直接 import
    `deletePostAndTombstone` 绕过门面。把这一处调用改走 service，既复活该方法，
    又消掉 AGENTS 规则 8 那 9 处直连中的一处——**这是该笔债里唯一有名字成因的一处**。
B15. ~~**adapter 直接调 `chrome.*`（5 个文件，不在任何已有规则里）**~~ —— **已完成（2026-09-12）**。
    查证后发现队列条目的前提是错的：这**不是分层口径问题，而是死代码**。
    5 处里 3 处是 `bilibili`/`weibo`/`xiaohongshu` 各自的 `checkAuthStatus()`，直接读本平台
    cookie（`SESSDATA`/`DedeUserID`、`SUB`/`SUBP`、`web_session`/`a1`）——**全仓零调用方**
    （src/entrypoints/tests/e2e 全查），**产物里 6 处全是对象字面量方法定义、无一处调用**
    （SW 与 dashboard 各打包一份），且无任何动态访问（`['checkAuthStatus']`、`?.`、反射）。
    同一份 cookie 名知识在 `platformAuth.ts` 里另有一份**活着的**（`usePlatformLogins.ts` 在用，
    驱动设置页的登录指示灯），并且**已经开始漂移**：`platformAuth` 的 bilibili 有 3 个 cookie 名、
    adapter 那份只有 2 个；小红书 `platformAuth` 有 `webId`、adapter 没有。
    已删除三个实现 + `PlatformAdapter` 的 `checkAuthStatus?` 声明。验证：产物中该标识符
    **6 → 0 处**，typecheck/lint/525 项测试全过，真机门禁 **17/17**（含设置页渲染）。
    剩下 2 处 `chrome.runtime.sendMessage`（`douyin.ts`、`twitter.ts`）**保留并在 AGENTS 规则 8
    明文承认为 sanctioned 边**——adapter 无法自己完成页面注入采集，包一层只是把同一个调用下移。
    教训：这条挂了三轮的口径问题，真身是 B28 的同类（声明了却没人跑）；「这算不算违规」这个问法
    把「它到底跑不跑」给盖住了。
B16. ~~**`e2e/README.md:97` 承诺了一个不存在的样例文件**：它说 `e2e/probe-result.json` 是探针的
    输出样例，但该文件被 `e2e/.gitignore:2` 正确忽略（已核实未跟踪），新克隆的人拿不到。
    要么提交一份脱敏样例，要么删掉这句话。
B17. ~~**测试缺口（已核实）**~~ —— **已完成（2026-09-11）**：① `clearStaleUpdatingStatus` 新测试 3 例（迁至 `tests/channelRepository.staleStatus.test.ts`，两个变异各自被抓住）；② `tco.ts` 的 19 个用例从 `tests/twitter.emptyTimeline.test.ts` 移入 `tests/tco.test.ts` 并补 `isTcoUrl` 直测（变异：放宽 `t.co` 匹配 → 3 例失败）；顺带删掉 `src/adapters/twitter.ts` 里只被测试引用的 `export { stripAppendedLinks }`（再导出已无生产消费者）。剩余缺口见「平台评估建议」。原始描述：：`channelSync.clearStaleUpdatingStatus` 与 `tco.isTcoUrl` 无测试；
    更要紧的是 `tco.ts` 的测试**只**寄生在 `twitter.emptyTimeline.test.ts` 里（20 处引用），
    按模块名 grep 会误判为「无测试」。另有 7 个 >150 行模块零测试引用，
    负载最重的：`twitterTimeline.ts`(486)、`bilibili.ts`(435)、`xiaohongshu.ts`(389)、
    `weibo.ts`(323)、`postRepository.ts`(212)。唯一该拆的大测试文件是
    `twitter.emptyTimeline.test.ts`(756，四个不相关关注点)。
B18. ~~**零成本清理**~~ —— **已完成（2026-09-11）**：删空目录 `src/db/`；`.gitignore` 去掉 `.e2e-profile/`（无脚本写它）；`!.env.example` 保留（它是 `!.env*` 的显式豁免，注释已说明）。原始描述：：空目录 `src/db/`；`.gitignore:9` 的 `!.env.example`（文件不存在）、
    `:39` 的 `.e2e-profile/`（无脚本写它）、`:40` 的 `bun.lock`（无 bun 痕迹）。
    `public/icons/icon.svg` 全仓零引用，但**可能是 WXT 的图标源，删前须验 build**。
B19. ~~**`FeedView.vue` 的两块可拆**~~ —— **已完成（2026-09-11）**：`usePlatformDnD.ts` 与
    `useWaterfallFeed.ts`，视图 **653 → 534 行**。验收用新增的 `e2e/feed-render.mjs`
    （真实 Chrome，10 步 **逐字节全等** 2,508,622 B；含拖拽落库与无限滚动 36→72 的断言）。
    **这个工具本身先被修过三轮才可信**：① 相对时间标签按小时漂移 → 夹具改为按天；
    ② 未读卡片会与「标记已读」写库赛跑 → 夹具预置 `isRead: 1`；
    ③ 视口尺寸在应用挂载后才设置 → 改为 `about:blank` 先设度量再导航。
    另：「无限滚动没触发」原本只打一句 NOTE，**这会让一次没滚动的捕获与其它捕获不可比**，
    现改为断言失败、不写文件。原始描述：（审计里唯一「纯收益」的拆分）：平台侧栏拖拽排序（约
    `FeedView.vue:62-110`）与 masonry 分列 + 高度估算（约 `:162-197`），两者自包含、
    与 context 无共享状态。其余 7 个大文件**审计判定不该拆**（「一个东西的很多方面」，
    或受注入序列化/清理不变量约束），理由见评审文件。
B20. ~~**popup 会加载全部 10 个平台 adapter**~~ —— **已完成（2026-09-11）**，做法是两处真改动：
    ① `clearStaleUpdatingStatus` 从 `src/sync/channelSync.ts` 移入 `channelRepository`
    （经 `channelService` 暴露）——它只是一次 channel 写入，却因为住在 sync 层而让每个调用方
    （含 popup）拉进整个 registry；
    ② popup 的首次抓取改由 SW 执行（新消息 `SYNC_CHANNEL`）：`chrome.runtime.sendMessage`
    会在等待 `sendResponse` 期间保活 worker，所以**关掉弹窗不再中断首次抓取**（此前
    popup 直接 `updateChannel` 且 fire-and-forget，关窗即丢）。查证：`main` chunk
    250 → 194 KB 且**已无任何 adapter 实现**（dashboard 297 KB 才带 adapter）。
    顺带修掉一个刚写出来就发现的缺陷：`updateChannel` **不抛异常**，它 resolve 出带 `error`
    的 FetchResult——只 catch 的 handler 会把限流/不支持平台报成成功；已改为读 `error`。
    门禁新增 `syncChannel.message-round-trip`（真实 router + 真实 SW，两个变异各自被抓住：
    删 dispatch 分支、删策略表条目）。原条目：`useQuickFollow.ts:9`
    从 `src/sync` import `updateChannel`，经 `channelSync.ts:5` 触达 `platform/registry.ts`，
    而该文件静态 import 全部 adapter（`:3-12`）。构建**确有**代码分割，但 `popup.html`
    会 `modulepreload` 那个 256 KB 共享 chunk（已核实其中含 Bilibili/Xiaohongshu 的
    adapter 字符串，而 popup 自己的 31 KB chunk 一个都没有）。后果只是体积与冷启动，
    不是正确性；修法（registry 懒加载 / 给 popup 一条更窄的同步入口）是对同步取 adapter
    方式的真改动，不是一行。
B21. ~~**`src/utils/http.ts` 应归位到 infrastructure/chrome/**~~ —— **已完成（2026-09-11，提交 `0af1016`）**：
    已移为 `src/infrastructure/chrome/http.ts`，10 处 import 与文档/注释一并更新。
    **实测核实**：`utils → chrome` 现为 **0 条边**（环已消），`adapters → chrome` 为 8 条边、
    全部指向该文件——这条边**本来就在**（每个 adapter 都经 `utils/http.ts` 到达 chrome 层），
    移动只是不再掩盖它；规则 8 已补上这条边的说明。原条目：
    它 import `bgFetch`（`:1`），`bgFetch` 又 import `utils/devLog`（闭合成环）。成因正当
    （规则 6 要求 SW 直调 `performBgFetch`），但那只解释**这条边**、不解释**它该住在 utils**：
    `http.ts` 是全部 adapter 取数经过的网络端口（fan-in 9）。把文件挪进
    `infrastructure/chrome/` 即消环，且不需要加任何间接层。
B22. ~~**规则 8 的台账出现漂移**~~ —— **已完成（2026-09-11）**：B14 已把台账从 9 改成 8，但「一处」没有定义、正是它上一次悄悄失效的原因；AGENTS 规则 8 现在直接列出 4 个文件与各自的使用点，并写明「数**使用次数**不是文件数，`import type` 不计」。原始记录：规则 8 记的 9 处直连里 8 处在它点名的四类内，
    第 9 处 `useDeletedPosts.ts:11`（回收站读路径直连 `postRepository`）**不在**。
    形态正是该规则禁止的（「优先加 service 方法而非新增直连 import」），却落在规则用来自我
    约束的清单之外——「已知债务、已枚举」这句话就是这样悄悄失效的。已记录未修。
B28. ~~**`enableR18Blur` 是死设置**~~ —— **已删除（2026-09-11）**：三处声明（类型、
    `DEFAULT_SETTINGS`、`useDashboardData`）全部移除，全仓不再有这个键。
    期间曾按「接上真正的模糊逻辑」实现过一整版：Pixiv `xRestrict` → `Post.isSensitive` → 卡片模糊
    ＋逐卡揭示，含 4 个组件测试、4 个适配器测试、1 个门禁步骤，并在真实浏览器里量到
    `filter: blur(40px)`；**随后整体回退**。理由：**这个能力在本产品里没有收益**——本地个人工具、
    不绕过任何登录限制，用户看到的本来就是自己账号能看到的内容，在自己的私人聚合器里模糊它没有
    安全意义；代价却是引入一个平台评级字段、一个新失败面（字段名一变即静默失效）与相应验证成本。
    **过程教训（我的）**：我把问题当成了「怎么实现」，而真正的问题是「要不要」——我给的选项
    「确实需要这个能力时再接上」本身有歧义（读作「将来需要再说」也成立），用户选它并不等于要求
    现在就实现一版。**死设置的正确处理是删除或明确记录，不是顺手替用户把它实现出来。**
    经过与政策含义见 `docs/PUBLISHING.md` §1.5。原始记录：

B28. **`enableR18Blur` 是死设置**（2026-09-11 核对商店政策时发现）：全仓 3 处出现——类型声明
    （`types/index.ts`）、`DEFAULT_SETTINGS` 默认值、`useDashboardData` 的默认值——**没有任何组件
    或逻辑读取它**；设置页的布尔开关只支持 `enableAutoSync` 与 `hideReposts`（`updateBooleanSetting`
    的参数是这两个的联合类型）。一个「默认开启」的模糊开关存在但不起作用，比没有这个设置更糟：
    它读起来像一项已实现的合规能力。修法二选一：接上真正的模糊/隐藏逻辑，或删掉它（含类型与默认值），
    **不要留着当装饰**。与上架相关：商店对不适合全年龄的内容要求标记 Mature，而这条决定依据是
    「产品实际会展示什么」，所以先定这个设置的去留，再定商店的 Mature 标记。
B29. **上架的合规缺口**（**已随「不上架」决定失效**，2026-09-11 用户决定不提交商店；材料保留在
    `docs/PUBLISHING.md` §1.4，将来若重新考虑上架再执行）：共 5 条——
    其中第 1 条最硬：*Limited Use* 第 6 条要求扩展自有网站上有固定措辞的主动声明
    （"The use of information received from Google APIs will adhere to the Chrome Web Store User Data
    Policy, including the Limited Use requirements."），而 `docs/PRIVACY.md` 目前**没有**这句话。
    其余为：隐私政策需要可填写的公开 URL；`optional_host_permissions: ['*://*/*']` 必须在文案里
    点名解释（政策禁止为未实现功能预申请权限）；描述不能只是平台名清单（Keyword Spam）；
    Mature 标记待定（依赖 B28）。
B30. **Withny 平台整体移除**（2026-09-12，用户决定）——**已完成（提交 `0774e68`）**。现为 9 个平台。改动位点：适配器文件、
    `PLATFORM_HOSTS`、`platformAuth` 的 cookie 行、`pathResolver` 的目录名、`Platform` 联合类型、
    `PLATFORM_REGISTRY` 条目、`registry` 注册、`urlParser` 的主机提示与解析分支，以及
    README / PLATFORMS / ARCHITECTURE / PUBLISHING / 设置页文案。**已验证**：产物 `host_permissions`
    19 → 18（派生自 allowlist，符合规则 2）、519 项测试全过、全仓 `withny` 零残留。
    顺带发现一个**既有漏项**：`urlParser` 为 Withny 生成 `Withny_${uid}` 占位名，而 channelSync 的
    两份占位前缀列表**都不认它**——频道名判据含 `startsWith(channel.platform)`（小写 `withny`），
    但 `'Withny_x'.startsWith('withny')` 为 false，也没有像 `Pixiv`/`Fantia` 那样的显式大写条目；
    创作者名单里则完全没有 Withny。也就是说**它的真实昵称从来没被写入过**，正是规则 9 描述的那种
    静默失败。平台已去，问题随之消失，但**规则 9 的两份清单值得据此复核一遍**。
    **存量数据**：已绑定过 Withny 的用户其 channel 行仍在库里；`getAdapter` 返回 undefined，
    `updateChannel` 在写 `updating` **之前**返回「不支持的平台: withny」，落库为可见错误
    （`channelSync.ts:506`），不会卡在「同步中」也不会静默跳过；UI 对未知平台退化为原始 key ＋
    中性徽章（各处已是 `?.` 兜底）。**未做删除迁移**——破坏性操作；用户可在关注管理里自行删除该
    频道（`channelService.deleteCascade`）。新增 `tests/channelSync.unsupported.test.ts`（3 例）钉住
    这条契约，并把「把 adapter 检查挪到 `updating` 写入之后」的变异验证为会失败。
B33. **平台评估的三条落地项**（2026-09-12 处理状态）：
    ① **RSS 真实 fixture 做法已写进 `docs/DEVELOPMENT.md` §10**（fixture 必须逐字来自真实报文、
    必须包含修复所依赖的字段、「注释断言上游行为而无载荷支撑＝披着引用外衣的猜测」），并写明本仓现状：
    RSS 是唯一用真实报文测 adapter 的平台，Twitter 的 fixture 是手工构造的。
    ② **有意不补测试的模块已记录（同节）**：`youtube.ts`(111) 的 **RSS 映射**有意不补——
    官方 feed 上的平直 `filter().map()`，每个字段都有 `||` 兜底，没有「解析一半」的中间状态。
    **但同文件真正脆弱的一段反而没测**：`@handle → channelId` 的三正则兜底；三个全 miss 时
    channelId 保持原样并拿去请求 RSS，之后的行为**未实测**（可能是如实报错，也可能是「成功但 0 条」）。
    `withny.ts` 已随平台移除。
    ③ **`bilibili`(435) / `xiaohongshu`(390) 的提纯+测试：未做，且不该贸然做。** 解析段与网络请求
    深度交织（item 映射循环套在 `if (res.ok)` 内），两个文件**零回归网**——直接提纯等于在无网状态下
    改主路径。正确顺序是：先抓一份真实载荷做 fixture → 再提纯 → 最后断言同一份 fixture 解析结果不变。
    需要一次真实同步来取载荷，所以排在真机验证（B26）之后。
B32. **占位名前缀清单与 `urlParser` 系统性脱节**（2026-09-12，B30 的同类问题查全的结果）——
    **部分完成（提交 `c9b97e8`）：缺失的 8 个前缀已补齐，复核 15/16；根治（改为单一来源＋守卫测试）未做**——
    拿 `urlParser` **实际生成**的 16 个 `suggestedName` 前缀，逐个对 channelSync 的两份手写清单判：
    **修复前 8 处缺口**，全部会真实发作（不是理论问题）：9 个 adapter **都会**回传
    `authorMeta.name`（rss 回传 feed 标题、youtube/pixiv 回传 `authorName`…），所以权威昵称拿得到，
    只是写不进去；后果是从「单个作品链接」关注一个创作者后，目录里永远留着 `Pixiv作品_12345`
    这种机器名。**根因是两点**：
    ① 两份清单里都有的 `startsWith(channel.platform)` **区分大小写**——`'YouTube视频_x'` 不以
    `youtube` 开头、`'RSS_x'` 不以 `rss` 开头（`Pixiv`/`Fantia` 之所以被显式列出，正因同样原因）；
    ② 创作者名清单是**另一份**手写清单，只覆盖「个人主页」形状（`Pixiv画师_`/`Fantia俱乐部_`/
    `小红书_`/`微博_`），**完全没覆盖「单个作品」形状**（`Pixiv作品_`/`Fantia投稿_`/`小红书笔记_`）。
    已按用户选择**只补齐缺失前缀**（频道侧 +`RSS_`/`YouTube视频_`；创作者侧 +7 个），
    复核由「从 `urlParser` 与 `channelSync` 源码直接抽取」的脚本重跑：16 个前缀 **15 覆盖**。
    **剩余 1 处不动，且是有意留的**：twitter 的 `suggestedName` 是 `@handle`——**频道侧**由
    `currentName === '@'+accountId` 等值判据覆盖，**创作者侧**不被覆盖。也就是说两侧口径不一致；
    但 `@handle` 本身就是该账号合理且可辨识的显示名，是否应被资料页显示名覆盖是**产品取向**，
    不擅自改（记此备查）。**未加守卫测试**（用户明确选择不做）：两份手写清单与 16 个生成前缀的一致性
    仍无人守护，Withny 已静默失败过一次、这 8 处是第二次；要根治应把前缀改为从 `urlParser` 单一来源导出。
B31. ~~**`FetchError.retryable` 是只写字段**~~ —— **已删除（2026-09-12，用户选 A）**。
    证据（三条独立）：`src`/`entrypoints` 零读取方；`background.js` 里该标识符只出现 **1 次**、
    形态是工厂里的写入 `{code:e,message:t,retryable:n}`；`main`/`popup` chunk 为 0。
    最能说明它冗余的是 `douyin.ts:100`——唯一"使用"这个概念的地方是**从 `code` 反推**出来的
    （`code === 'network' || code === 'rate_limit'`），即它不携带 `code` 之外的任何信息。
    已删除：`FetchError` 字段、`fetchError()` 第三参、**22 处调用点实参**（20 处单行 + 2 处多行
    形态，后者正则没覆盖到、由 typecheck 抓出），并改掉 2 个把该字段当契约来钉的测试
    （`adapters.test.ts` 原本断言"传了就保留、没传就省略"——那是**机制**，现在断言整个形状，
    因为该形状是刻意的）。
    验证：typecheck/lint 通过，**524 项测试**（少 1 项：两条机制断言合并为一条形状断言），
    产物中 `retryable` **4 个文件全部归零**，真机门禁 **17/17**。
    **为什么不做 B（接上重试）**：那会新增一条重试路径＝向刚失败的平台多发请求，与 AGENTS 规则 19
    直接冲突（「检测到限流后继续猛打，比不检测更糟」）；且 `douyin` 把 `rate_limit` 标为可重试——
    该选项会专门重试保护机制最脆弱的平台。改回 B 的条件是：有一个**实测**案例证明某平台某 code
    立即重试确实有效，现在没有这样的数据。
B26. **`PLATFORMS.md` §2.2 的 Twitter 建议此前是空头支票**（随 B10 修复，**待真机复验**）：
    该节说「可先在浏览器中打开目标博主的推特主页标签页，扩展会优先复用当前活跃标签页的前端网络会话」
    ——在注入路径修好之前，这句话做不到（函数一进页面就 `ReferenceError`）。修复后逻辑上成立，
    但**尚未在真实 x.com 上验证过**（需要人已登录的 x.com 标签页）。
    **2026-09-12：路径已可观测（`9cd61aa` 之后）**——此前两条路径在日志里**完全无法区分**：
    直连用的是 SW 原生 `fetch`（不写 `bgFetch:` 行），它的失败只 `console.warn`，而开发者日志不采集 console。
    所以一次真实同步日志里 `消息 FETCH_TWITTER_TIMELINE` 之后直接就是「同步完成」，**看不出**是
    「页面路径成功」「直连成功」还是「页面路径失败、直连兜底」——而最后一种正是修复前长期的状态。
    现在：**标签页路径是主路径，直连只是兜底**（处理器注释原文 `Keep the proven page-context path as primary`），
    成功记 `debug`（需开面板「详细模式」才可见，避免每次同步都刷屏，规则 20），**任何兜底记 `warn`（默认可见）**。
    验证办法：开「详细模式」后同步一次推特渠道，日志应出现「标签页路径采集成功」；若出现
    「标签页注入未返回结果」或「直连请求失败，改走标签页路径」则是主路径失败。
    `tests/twitterTimeline.injected.test.ts` 新增 3 例钉住「顺序 + 可观测性」，4 个变异各自被抓
    （顺序反转、删掉三处日志中的任意一处）。
B27. **父级自查：提交信息声称「已记入文档」而实际没写**（本次会话发生一次）：`fca660a` 的
    提交信息写着「recorded in docs/REVIEW_2026-09.md」，但两处更正当时一条都没落地。
    与规则 26 同源——**「我说我做了」不是证据，文件里有没有才是**。已补齐（平台表那行、
    方法注记里的「生造键名」更正、本条目、AGENTS 规则 9 的案例）。

B24. ~~**「清除筛选」按钮不清账号类型筛选**~~ —— **已完成（2026-09-11）**：新增
    `clearAllDirectoryFilters()`（住在状态旁边，而不是在模板里手写一遍），按钮改为调用它。
    新增 `tests/creatorDirectoryFilters.test.ts` —— **挂载真实视图、点真实按钮**。
    第一版只测了 composable，把模板改回手写三筛选的变异**不会失败**（测试看不见真正坏掉的那处）；
    改为挂载后同一变异立即失败。原始记录：`CreatorsView.vue:594`
    的空态按钮只重置 `creatorSearch`、`creatorPlatformFilter` 与标签三态，**不重置
    `creatorRoleFilter`**。而空态判据是 `filteredCreatorsList.length === 0`，后者包含角色筛选
    ——所以当「账号类型」是唯一把列表清空的原因时，这个按钮点了没有任何反应。修法是一行
    （把 `creatorRoleFilter = 'all'` 加进那个表达式），但那是行为改动，没有混进 B11 的纯重构提交。
B25. **`e2e/creators-render.mjs` 的第 20–22 步曾是**非确定性**的（已修）**：它捕获了排序下拉框的
    动画中间态。同一份构建连跑两次，恰好在且仅在这 3 步上不同——根因是规则 30：**离屏未合成的
    窗口不产生帧**，而该下拉是 Vue `<Transition>`，其进退场动画永不收敛。已改为捕获前关闭下拉、
    并用 `aria-expanded` 断言开合状态（`aria-expanded=true` / 选项出现 / Escape 后 `false` /
    触发标签变为「手动排序」），比原先的截图更强。**影响面**：这 3 步恰是手动排序那几步，
    所有重构都没碰；其余 19 步（三套模板、筛选、排序、标签、批量）从无抖动，那部分证据仍然成立。
    同一次还暴露出父级在点击后**同步**读 DOM（读到的是上一帧），`AppSelect` 因此看起来是死的——
    与规则 30 末段同一条。

B23. **分层总评（逐条验证通过）**：12 个 adapter 零 db import（规则 1 成立）；
    `infrastructure/db/*` 零 `chrome.*`（规则 2 成立方向）；`douyin/collector.ts` 自包含
    且是唯一 collector 文件（规则 9 成立）；无 2-节点环；最长依赖链 11 个模块且全程向下。
    `urlParser.ts` 8 处子串判定判定为「可疑但不违规」——它们丢弃输入 host、在硬编码域名上
    重建 `cleanUrl`，与抖音的注入决策不同源，见评审文件。

#### 队列 C — 需要用户决定

8. **发布范围**（二.10）：**材料已起草（2026-09-11）** —— 新增 `docs/PUBLISHING.md`
   （商店清单字段含当前值与改写提案、逐权限理由与代码位置、审查员可自查的三个「不是」、
   升级与降级说明、抖音/X 能力边界的如实表述）。**仍待用户决定的三件事**写在该文件 §1：
   是否上架、抖音表述口径、发布范围与版本策略——未确认前不要提交审核。
   前置事实：抖音路径**没有官方 API 解法**（`DOUYIN_RESEARCH_2026-09.md` 一/二节），
   上架说明必须如实呈现这一点（已写进 §4.3，含「隐藏作品计入标注数」这条容易被当成故障的事实）。
9. **P6 整体 UI 风格重设计**：用户明确「当前不排期」。注意与队列 A.3 撞车，先拆后设计。
10. **Non-goals**（`AGENTS.md` 有专节，不要再提议）：RSS 卡片不显示配图；视频缩略图不加
    角标/播放图标。
11. ~~**E2E 门禁要不要也跑在 PR 上**（A.2 的后续，需要用户拍板）。~~ ——
    **已决定并落地（2026-09-11）**：用户拍板加入。`ci.yml` 的 `verify` job 在 `npm run build`
    之后增加「Ensure Chrome and Xvfb are available」+「`xvfb-run -a node e2e/release-gate.mjs`」，
    与 `release.yml` 同一步骤。本机（Windows，同一脚本的 Chrome/CDP 部分）实测 **3.9 s / 16 项**。
    **首次推送即失败，且三次连续失败**（2026-09-11 的 `feat(sync)`／`docs(publishing)`／
    `chore(release)` 三个提交）：失败在我自己写的那一步 shell 里——
    `(command -v google-chrome || command -v google-chrome-stable) --version`，
    **给子 shell 传参数是非法语法**，bash 报 `syntax error near unexpected token '--version'`，
    于是 **E2E 门禁根本没跑到**（失败在它前面的准备步骤）。`release.yml` 里是同一行、同一个错误。
    已修为 `chrome_bin="$(command -v … || true)"` 后判断并执行；用 Git for Windows 的 bash 5.3
    逐条 `bash -n` 校验两个 workflow 的全部 `run:` 块（旧行在本机复现出完全相同的报错，
    新行全部通过）。`ci.yml` 另加 `workflow_dispatch`，可 `gh workflow run ci.yml` 手动触发。
    **教训**：CI 的 Linux 路径不是「本机跑不了所以放着」——它一直在跑，只是**从没跑过我新加的那一步**。
    代价与取舍（原始记录）：现状：只在打 tag 的
    `release.yml` 里跑，所以「自动同步开关通知早于落库」这类**只有真实宿主能暴露**的回归，
    要等到发版才被拦住。放到 `ci.yml`（push/PR）上跑一遍的代价是每个 PR 多起一次
    Chrome + Xvfb（本机实测整轮 **3.5 s**，CI 上主要是浏览器启动与拉镜像）。
    取舍：PR 覆盖 vs CI 时长与被浏览器环境波动拖累的风险。想加的话，加在 `ci.yml` 的
    `verify` job 之后、`xvfb-run -a node e2e/release-gate.mjs`，`.output` 已由该 job 构建。

#### 仍不可验（环境限制，别浪费时间重试）

- **alarm 跨浏览器重启的长期行为**：CDP `loadUnpacked` 加载的扩展不跨重启留存，
  重启后重新加载等同全新安装，alarm 与 `onInstalled` 时序都被重建而非延续。
  要验只能在真实安装的扩展上做。
- **抖音 / Twitter 路径的固有脆弱性**（二.7 / 二.13）：属外部依赖，本地重构无法消除。
- 二.13 已更正：抖音同步**无**前置条件（不再要求用户先打开创作者主页）。

#### 已知陷阱（本次会话踩过，省你时间）

- 扩展 E2E 必须带 `--enable-unsafe-extension-debugging`，否则 `Extensions.loadUnpacked`
  报 `Method not available`（规则 28，已按实测改写）。
- 导入成功路径的 `alert()` **阻塞渲染进程**，连带 `Runtime.evaluate` / `Page.enable` 永久挂起；
  须在执行动作前启用 Page 域并应答 `Page.javascriptDialogOpening`。
- 视觉验证只开独立 profile 的专用实例，绝不驱动用户正在浏览的窗口（规则 25）。
- jsdom 不做布局：几何问题用规则 30 的单文件 HTML 打包在真实排版引擎里量。
- 脚本化改写必须断言命中数，否则「匹配不到」会产出假绿（规则 26）。
- 本仓库 `core.autocrlf=true`：签入为 LF，工作区可能是 CRLF，多行锚点会匹配不到。
