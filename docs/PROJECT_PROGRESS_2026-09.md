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
- **已知技术债**：`CreatorsView.vue` 需要继续拆分（**行数以四.P4 为唯一口径**，仍在增长）。
  三个迁移期兼容桶（`src/adapters/index.ts`、`src/db/index.ts`、`src/platform/index.ts`）
  与零引用脚手架 `components/DashboardSection.vue` **已于 2026-09-11 删除**。
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

### 2. `CreatorsView.vue` 仍然较大

文件从 1420 行缩减到约 1100 行，主要重复块已提取，但仍同时承担：
（第三批新增拖拽排序、账号类型筛选与独立标签列，第十六批又加平台指示器，拆分目标持续变远。
**当前行数与拆分进展只记在四.P4**，本节不再重复数字——两处各记一个数字正是本文档此前失准的原因。）

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

### P4：继续拆分 CreatorsView

按 toolbar、grid、list 和 detailed 布局继续拆分。
（实测 2026-09-11 复核：**1481 行**，比二.2 记录的约 1100 行更大——第三批新增了拖拽排序、
账号类型筛选与标签列，第十六批又加了平台指示器，第八/九批（浮动控件、表格展开控件）
亦在其中；拆分目标持续变远。）

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
2. **把 2026-09-11 的 E2E 探针固化成脚本**（`e2e/` 目录已存在，内含 `douyin-probe.mjs`
   与 `drive-extension.mjs` 可作范式）：三步——`Extensions.loadUnpacked` 加载构建产物 →
   备份导出/导入往返 → 连开 popup 读 `alarms.getAll()`。接进 `release.yml` 作为发布前门禁。
   今天这些是手工跑的一次性验证，不固化就只值一次。
3. **P4 `CreatorsView` 拆分**（**1481 行**，仍在增长；证据已足，唯一「证据齐了却没排期」
   的债）。按手册第 9 节写清边界再动手，建议第一个切片：
   问题位置=视图同时承担搜索排序/标签三态/批量模式/masonry 分列/三种主模板/同步状态聚合；
   最小方案=先提 `useCreatorDirectoryFilters` + `CreatorDirectoryToolbar` 两块；
   需保持的行为=筛选与排序结果、三视图模板输出逐字节不变；验证方式=现有
   `tests/creatorsTable.test.ts` 等 + 真实扩展渲染对比（不要求像素等价，但要能说明差异）。
4. **开成本账**（手册 13.3）：每平台两列——修复提交数 / 人工介入次数。先记一个月，
   用于决定小红书 / Twitter / 抖音这三条高 churn 路径是否降级为「尽力而为」。
   当前这笔账是隐形的。

#### 队列 B — 用户已批准或已列为不足，未实施

5. **悬停预取**（用户已认可方案）：鼠标停在左侧平台按钮上时预取该分组首屏约 36 条动态的
   图片（约 12 MB）。纯优化，排在缺陷修复之后。
6. **二.4 `FetchError` 精度与重试**：宽范围 `try/catch` 仍会把解析/认证问题归为 network；
   `retryable` 尚未驱动实际重试。需按 HTTP/解析/schema/timeout/transport 分开分类，
   再实现受限指数退避。
7. **二.5 备份校验不是完整 schema**：缺 timestamp 有限性、platform 枚举、跨表引用完整性、
   重复 ID、settings 字段范围、`isRead`/`isBookmarked` 必须为 `0|1` 等检查。

#### 队列 C — 需要用户决定

8. **发布范围**（二.10）：代码侧权限已收窄（去 `tabs`、DNR WithHostAccess、RSS 按站点授权），
   但 Chrome Web Store 的安装提示与审核说明未写；发布候选还需安装/升级说明。
   前置事实：抖音路径**没有官方 API 解法**（`DOUYIN_RESEARCH_2026-09.md` 一/二节），
   上架说明必须如实呈现这一点。
9. **P6 整体 UI 风格重设计**：用户明确「当前不排期」。注意与队列 A.3 撞车，先拆后设计。
10. **Non-goals**（`AGENTS.md` 有专节，不要再提议）：RSS 卡片不显示配图；视频缩略图不加
    角标/播放图标。

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
