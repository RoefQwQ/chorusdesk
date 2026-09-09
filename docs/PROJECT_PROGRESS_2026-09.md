# Chorus 项目进步与剩余不足 — 2026-09

## 结论

本阶段最初目标是修复代码审查发现的 28 个问题，并完成修复队列 1–12。

项目已经从“功能覆盖较广，但安全边界、后台同步和数据索引依赖隐含假设，且缺少持续验证”，提升为：

> 具备明确安全边界、稳定数据契约、可解释同步流程、基本性能治理和持续集成的可维护 Chrome MV3 扩展项目。

本阶段最大的价值不是新增功能，而是让多个“表面存在、实际可能静默失效”的功能具备正确的实现基础，并把关键规则固化为代码契约和自动化测试。

尚未达到的状态是：完成真实 Chrome 端到端验证、最小化权限、完整数据 schema、统一平台描述协议、成熟外部 API 策略和完整工程静态检查的发布级产品。

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

现有 37 项测试覆盖：

- hostname 与 sender 安全边界。
- 仿冒 host 回归。
- FetchError 和 buildPost 契约。
- backup validation。
- UI 组件 SSR。
- BaseModal dialog semantics。

TypeScript 固定为 `7.0.2`。关键缺陷不再只依赖维护者记忆。

### 10. 云端仓库隐私和整洁性提升

完成：

- 未来 Git 提交使用 GitHub noreply 邮箱。
- `.gitignore` 覆盖环境文件、密钥格式、数据库、备份、日志、HAR、浏览器 profile 和构建产物。
- 阶段报告使用仓库相对路径。
- 安全审查改为适合公开仓库的结论版。
- 删除产品无关的内部 agent 调度记录。

---

## 二、仍然存在的不足

### 1. 最大证据缺口：真实 Chrome 扩展 E2E

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

### 8. Rplay Token 运行时姿态仍可加强

仓库没有保存真实 Rplay token，但运行时仍把完整 token 保存在 `chrome.storage.local` 并短暂进入 UI reactive state。

后续可考虑：

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

### 11. 尚未配置 ESLint

CI 可以发现类型错误、测试回归、构建失败和 Vue SFC 编译错误，但不能系统约束：

- floating Promise。
- 新增 `any`。
- 层次违规。
- 死代码。
- 高复杂度条件。

ESLint 应单独引入，避免与业务修复混成大规模格式噪音。

### 12. Dexie migration 尚未进入永久 CI

v3→v4 曾用真实 Dexie 升级链验证，但一次性脚本已清理。

值得保留为永久测试：

- 建立 v3 数据库。
- 写入 boolean posts 和 tombstone snapshots。
- 用当前数据库类打开。
- 断言值转换为 0|1。
- 断言索引查询命中。

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

### P0：真实 Chrome 人工验证

1. 加载 `.output/chrome-mv3`。
2. 检查 Service Worker 控制台。
3. 检查 Grid/List/Detailed。
4. 检查六个 modal 的焦点、Escape、backdrop 和滚动恢复。
5. 检查微博、Pixiv、小红书媒体资源。
6. 手动同步主要平台。
7. 检查 unread badge 和 bookmark。
8. 导出并重新导入备份。
9. 检查 alarm scheduled time。

### P1：直接修复人工验证发现的问题

优先处理 UI 视觉回归、DNR 不命中、自动同步未触发、头像 URL 失效，以及 senderGuard 与真实 sender 字段不一致。

### P2：永久 Dexie migration 测试

把 v3→当前版本升级链加入 CI。

### P3：收窄运行时敏感状态

减少完整 Rplay token 进入长期 UI reactive state。

### P4：继续拆分 CreatorsView

按 toolbar、grid、list 和 detailed 布局继续拆分。

### P5：单独引入 ESLint

采用最小 flat config，避免无意义的全仓格式重写。

---

## 最终评价

本阶段实现了最初目标的大部分核心价值：

- 关闭凭据安全边界缺口。
- 修复 IndexedDB 静默索引失败。
- 修复自动同步双重断路。
- 阻止随机 ID、碰撞 ID 和 NaN 时间戳污染数据。
- 将字符串错误升级为结构化契约。
- 将关键规则转化为测试和 CI。

项目质量的提升是结构性的，而不是表面增加功能。当前最大差距已经从“代码存在明确缺陷”转移为“缺少真实 Chrome 产品运行证据”。
