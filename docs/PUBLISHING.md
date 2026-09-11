# 上架与发布材料（Chorus / chorusdesk）

> ## 决定记录（2026-09-11）：**不上架**
>
> 已决定**不向 Chrome 应用商店提交**。因此本文件的 §1 是**决策依据**（保留下来，免得下次
> 有人把同样的账再算一遍），§2–§4 是**待用素材而非执行计划**，§5 的版本机制**已实现**
> （见下）。§6 与发行流程无关，仍适用。
>
> 放弃上架换到的是：**零审核延迟、零政策风险、修复路径最短**。放弃的是**用户侧自动更新**——
> 商店版能自动升级，解压安装版必须手动覆盖。对一个「故障由平台改版驱动」的工具，这是已知的
> 长期成本，取舍见 §1.1 与 §1.2。
>
> 与上架无关但仍落地的一项：**清单版本支持可选的第 4 位**（§5.3）。它默认不生效——
> 不设 `CHORUS_STORE_REVISION` 时产物与从前逐字节一致——所以对当前发布流程零影响，
> 只在将来真要提交商店、或被驳回需要重提时使用。
>
> 另一个结论：`enableR18Blur` 这个死设置**已删除**（§1.5），并且**不做**内容模糊功能。

这份文件是**待发布的素材**，不是已发生的事实：目前没有在 Chrome 应用商店上架，也没有提交过审核。
它存在的原因很具体——上架材料里有几项**只有代码作者知道、审核员一定会问**的问题（为什么需要
`cookies`、为什么是 `optional_host_permissions: *://*/*`、抖音为什么不是「调接口」），
而它们一旦答错或答得含糊，结果是驳回重提、以及被质疑数据用途。

写之前的规则：**本文件里的每一句话都必须能对着产物或代码复核**。清单字段取自
`.output/chrome-mv3/manifest.json`（构建产物，不是 `wxt.config.ts` 的意图）。
权限用途的完整表格在 [`PRIVACY.md`](PRIVACY.md) §2，请求机制在
[`PLATFORMS.md`](PLATFORMS.md)，抖音的技术事实在
[`DOUYIN_RESEARCH_2026-09.md`](DOUYIN_RESEARCH_2026-09.md)。这份文件不复制它们，只回答商店侧的问题。

---

## 1. 决策材料：代价、依据、待办

§1 是决定「要不要上架」的材料，其余各节都是**已经写好、等决定后可直接用**的内容。
政策条文引用的是一手页面：[Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies)
（Last updated 2025-05-22）、[Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)、
[Quality guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)。

### 1.1 上架的代价

**钱不是代价。** 一次性 5 美元/开发者账号，之后无限发布，无年费。真正的代价是下面四条，
按「会不会真的发生」排序：

**(1) 审核延迟，而本项目的故障模式恰好是「平台今天改了」。**
审核时长从几小时到数周（复杂扩展、高峰期更久）。本项目 9 个平台的采集方式**全部**建立在
别人的网页结构、内部接口和会话之上：平台一改版，该渠道就死，而修复本身可能只是一行解析。
现在这条链路是「改 → 推 tag → 十分钟内 GitHub 可用」；上架后变成「改 → 等审核 → 生效」。
**这是最确定的代价，不是风险。** 缓解：GitHub Releases 始终保留为主渠道（见 §1.3）。

**(2) 政策风险，而且条款是一手可查的。** 本项目没有踩下面任何一条的**明文**红线，但有三条
贴得很近，被举报或抽检时如何判定不由我们决定：

| 条款（原文位置） | 为什么相关 |
|---|---|
| *Malicious and Prohibited Products* 第 4 条：**"Do not facilitate unauthorized access to content on websites, such as circumventing paywalls or login restrictions."** | 扩展用**用户自己的会话**读平台网页端接口，未绕过登录——但「用网页端未公开的 GraphQL 接口取数据」是否算「未授权访问」，是判断问题。抖音那条我们明确**不**绕过未登录限制（未登录就只放近期作品，扩展如实报告），这一点对我们有利。 |
| *Malicious and Prohibited Products* 第 5 条：**"Do not encourage, facilitate, or enable the unauthorized access, download, or streaming of copyrighted content or media."** | 扩展**把他人媒体缓存到本地磁盘**（`enableImageCache` + File System Access 授权目录，`fsManager.ts`）。「缓存到磁盘」比「展示」更接近这条的措辞。Fantia 是付费订阅平台，Pixiv 有付费内容——需要一条明确的「只缓存用户在浏览器里本就能看到的内容」表述。 |
| *Repeat Abuse* 第 2 条：**"Repeated infringement of intellectual property rights, including copyright, will also result in account termination."** + 同节：极端情况下 *"may also result in the suspension of related Google services associated with your Google account."* | **这条决定了用哪个账号**：不要用主力个人 Google 账号发布。用专用账号，并开启两步验证（*2-Step Verification* 一节要求发布前必须开启）。 |

**(3) 被下架是「永久 + 只有一次申诉」。** *Notification and Appeals* 第 3、4 条：下架除非提交修订
否则是永久的；每个违规**只允许申诉一次**。也就是说一次误判要花掉唯一的申诉机会。
*Minimum Functionality* 第 2 条还写着 **"Extensions with broken functionality—such as dead sites or
non-functioning features—are not allowed."**——对一个会被平台改版打断的采集器，这条是长期存在的
下架理由。

**(4) 上架后有一份不会自己维持的义务。** *Listing Requirements* 第 3 条：隐私字段必须与隐私政策
和扩展**实际行为**一致，不一致可能被下架；*Best Practices* 第 5、7 条要求元数据与联系方式始终
有效，「未响应可能被下架」。这些都是没有用户体验收益的长期维护项。

### 1.2 唯一的实质收益：自动更新

上架能给的、GitHub 分发给不了的东西只有一个：**用户侧零操作的自动更新**。
对一个「故障由外部改版驱动」的扩展，这不是锦上添花——它是产品能不能长期可用的关键。
其余（曝光、装机量、可信度）对本项目都次要，因为我们不需要装机量来摊薄成本。

**所以真正的取舍是**：用「修复延迟」换「用户不必手动更新」。而延迟只影响商店用户，
上一版在被审期间仍然在线（被驳回时旧版保留），所以最坏情况是**商店用户坏得久一点**，不是坏掉。

### 1.3 发布范围：三个互相独立的轴

不要把「上架」当成一个开关。它是三个可以分别决定的问题：

**轴一 · 分发可见性**（Public / Unlisted / Private）。
关键事实：**审核时长与可见性无关**（Google 官方社区的答复口径是 private/public 一视同仁）。
所以 unlisted **不是**绕过审核的捷径，它只控制曝光。含义：可以先用 unlisted 上线，
拿到自动更新能力，同时不进入搜索；等政策风险被实际使用验证过再转 public。
（注意 unlisted 的链接可被搜索引擎索引，不是真正的隐藏；private 则要求使用者登录 Google 账号。）

**轴二 · 功能范围。** 建议**不做商店专用分支**，理由不是懒：本仓的验证纪律
（逐字节渲染对比 + CDP 真机门禁 + 单一产物假设）是针对**一份产物**设计的，两个变体意味着
每次平台改版要跑两遍完整验证，而 9 个平台的维护成本已经很高。更重要的是风险不在某个可摘除的
功能上——如果商店不接受「读会话取数据」，那被摘掉的不是抖音，而是这个扩展的核心。

**轴三 · 渠道一致性（硬要求）。** 无论上不上架：**商店包与 GitHub 包必须来自同一 commit、同一 tag**。
否则「我装的是哪个版本、有没有这个修复」就无法回答，问题反馈也无从判断。

### 1.4 本次核对一手政策发现的合规缺口（上架前必须补）

这几条是**可执行的动作**，不是原则：

1. **必须在隐私政策里加一句限定用途声明。** *Limited Use* 第 6 条要求扩展自有网站上有一句
   主动声明，原文措辞固定：*"The use of information received from Google APIs will adhere to the
   Chrome Web Store User Data Policy, including the Limited Use requirements."*
   `docs/PRIVACY.md` 目前**没有**这句（已核对）。
2. **隐私政策需要一个可在商店后台填写的 URL。** *Privacy Policy* 第 3 条要求在指定字段提供链接；
   `docs/PRIVACY.md` 是仓库文件，需要一个稳定的公开地址（GitHub 链接即可，但别用会变的分支名）。
3. **`optional_host_permissions: ['*://*/*']` 必须在文案里点名解释。** *Use of Permissions* 第 1 条
   明确禁止「为尚未实现的功能预先申请权限」；审查员看到的是一条全站通配。理由（RSS 源域名用户自填、
   运行时按站点逐个授权）必须写在描述与隐私字段里，且 RSS 必须确实是**已实现**功能。
4. **描述不能只是平台名清单。** *Listing Requirements* 第 4 条把「Lists of sites/brands/keywords
   without substantial added value」列为 Keyword Spam。九个平台名排一排正落在这个形状上，
   必须有实质说明段。
5. **是否要标记为 Mature，需要按实际内容判断。** *Mature & Sexually Explicit Material* 第 5 条：
   内容不适合全年龄的产品应标记 Mature，且仅对已登录的成年账号可见；被标 Mature 会影响曝光
   （*Feature Products* 第 5 条「Content deemed not family friendly」不进入推荐位）。
   代码事实：产品**没有**任何内容模糊或过滤能力，也不会判断作品的年龄分级——能不能看到 R18
   内容完全取决于用户自己登录的账号能看到什么。按这个事实判断，需要标记 Mature 的可能性是
   **高**的，但这属于**推断**，最终以实际抓取到的内容为准。

### 1.5 本次核对顺带发现的代码问题

- **`enableR18Blur` 已删除（2026-09-11）。** 它此前有三处声明（类型、`DEFAULT_SETTINGS`、
  `useDashboardData`）而**没有任何读取方**——一个「默认开启」的模糊开关存在但不起作用，
  比没有这个设置更糟：它读起来像一项已实现的安全/合规能力。曾尝试接上真正的模糊逻辑，
  结论是**这个能力在本产品里没有收益**：这是本地个人工具，扩展不绕过任何登录限制，
  用户看到的本来就是自己账号能看到的内容，在自己的私人聚合器里模糊它没有安全意义；
  而实现它要引入一个平台评级字段、一个新的失败面（字段名一变就静默失效）与相应验证成本。
  因此设置、类型与默认值一并移除（队列 B28）。
- 建议同时复核图片缓存的授权文案，是否明确「只缓存你本就能看到的内容」（对应 §1.1 第 (2) 条）。

### 1.6 待用户决定的三件事

1. **是否上架。** 不上架则本文件是草稿，用户走 README §安装使用的解压安装路径。
2. **抖音能力的表述口径。** 官方 API **无法**实现「追踪任意创作者」（§4.3）。文案必须写成
   「读取你浏览器中可访问的公开页面」，**不能**写成「调用抖音官方接口」。
3. **可见性起点**：public 还是 unlisted 起步（审核时长相同，差别只在曝光）。

---

## 2. 商店侧清单字段（草稿）

| 字段 | 值 | 约束/来源 |
|---|---|---|
| 名称 | `Chorus - 跨平台创作者聚合展台` | 产物 manifest `name`，≤45 字符 |
| 版本 | `1.0.0` | 产物 manifest `version`；由 `package.json` 派生 |
| 简短说明（**现状**） | `聚合追踪B站、Twitter、Fantia、Pixiv、YouTube等选定创作者动态，支持多平台博主归集与被动更新。` | 产物 manifest `description`，59 字符 |
| 简短说明（**建议改写**） | `聚合B站、Twitter、Pixiv 等平台选定创作者的动态，本地存储、无账号、无遥测。` | 提案：现文案只列了平台与「被动更新」这一功能名，没提本地存储与无遥测——而这两点恰是商店用户最先问的。改文案要同时改产物 manifest（`wxt.config.ts`），不能只改商店页面 |
| 分类 | 生产工具 / 效率（Productivity） | 见 §1.3 |
| 语言 | 简体中文（主），可选英文 | 界面目前是中文 |
| 单一用途说明 | 「把用户选定的多个平台创作者主页，聚合成一处可筛选、可本地归档的动态流。」 | Chrome 审核要求填写 single purpose；见 §3 |

**详细说明的骨架**（照此写，不要加形容词）：

- 做什么：关注创作者 → 扩展从各平台**你已登录的会话**或公开页面读取其公开动态 → 统一列表展示、
  可筛选、可标记已读/收藏 → 可导出为本地 JSON 备份。
- 数据在哪：全部在本地 IndexedDB 与浏览器存储里；**没有服务端、没有遥测、没有统计上报**。
- 不做什么：不破解、不伪造签名或设备指纹、不代替你登录、不读取与同步无关的页面。
- 已知限制：见 §4。**这一段必须写进商店描述**，否则差评会集中在「抖音不支持」「推特 429」。

---

## 3. 权限逐条理由（提交审核时逐项填写）

产物申请了 6 个 `permissions`、19 条 `host_permissions`、1 条 `optional_host_permissions`。
逐条的**代码依据**如下（审核问「为什么需要 X」时照此回答）：

| 权限 | 为什么必须要 | 代码位置 |
|---|---|---|
| `storage` | 界面偏好、平台顺序、自动同步间隔、冷却状态。 | `settingsRepository`、`src/sync/rateLimit.ts` |
| `cookies` | 向**你已登录的平台**发起动态同步；扩展不新建会话，只复用浏览器里已有的。用于 B站/微博/小红书的登录态判断与 X 的会话请求。 | `bgFetch`（`performBgFetch`）、各 adapter 的登录检查 |
| `activeTab` | 你在创作者主页点扩展图标时，读取**当前这一个**标签页的地址与标题以识别创作者。只在点击后临时生效。 | `entrypoints/popup/composables/usePageDetection.ts` |
| `scripting` | ① 关注弹窗里提取**页面上已公开展示**的昵称/头像；② 抖音同步时向抖音标签页注入只读采集脚本（抖音无法从后台请求采集）。 | `usePageDetection`、`douyinSnapshot`、`src/adapters/douyin/collector.ts` |
| `declarativeNetRequestWithHostAccess` | 为防盗链图片改写 `Referer`，否则 B站/Pixiv/微博/小红书的图片全部裂图。**规则用 `initiatorDomains: [chrome.runtime.id]` 限定为扩展自己发起的请求**，不影响你正常浏览。 | `src/infrastructure/chrome/declarativeNetRequest.ts` |
| `alarms` | MV3 后台自动同步的定时器。 | `src/infrastructure/chrome/autoSync.ts` |

**host_permissions 为什么是这 19 条**：每一条都对应「同步时确实要请求的域」，分三类——
平台页面/接口域（`bilibili.com`、`x.com`、`youtube.com`、`pixiv.net`、`fantia.jp`、
`xiaohongshu.com`、`weibo.com`/`weibo.cn`、`douyin.com`）、平台 CDN 图片域
（`hdslb.com`、`twimg.com`、`pximg.net`、`xhscdn.com`/`.net`、`sinaimg.cn`、`douyinpic.com`）、
以及分享短链域（`xhslink.com`）。**没有 `tabs` 权限**（2026-09 移除）：不需要、也不申请。

**`optional_host_permissions: *://*/*` 是给 RSS 的，且必须按站点逐个授权**：
RSS 源由用户自己填写，域名无法预知，所以只能运行时申请。扩展**不会**在安装时拿到任意站点访问权，
也不把这条变成「任意站点可达」的白名单（见 `AGENTS.md` 规则 3：allowlist 管的是**凭据**，不是可达性；
非平台域一律 `credentials: 'omit'`）。

**审查员能自查的三个「不是」**（这三条是审核常见追问）：

- **不含远程代码**：全仓无 `eval` / `new Function` / 远程脚本加载，MV3 CSP 保持默认；注入的脚本是
  随包发布的字面量函数（`Function.prototype.toString()` 序列化，无闭包）。
- **无遥测**：全仓无分析/上报 SDK，无第三方请求。
- **日志不外传**：开发者日志写在 `chrome.storage.session`（会话级，浏览器重启即清），
  只记录主机名、HTTP 状态码、条数与错误文案——**不记录** Cookie、令牌、请求头、响应体或完整 URL。
  面板的意义是让你截图贴进问题反馈，所以它必须能公开看。

---

## 4. 审核与用户都需要看到的「如实说明」

### 4.1 采集方式：读你浏览器里已可访问的内容

扩展不同平台用不同机制，但共同点是**不伪造身份、不破解接口签名**：

- **公开页/内部网页接口**：B站、YouTube、Pixiv、Fantia、微博、小红书、X——使用
  网页端自身的接口与你当前的会话。
- **页面内注入（抖音）**：抖音无法从后台请求采集，扩展在你打开的（或它自己新建后即关的）
  抖音标签页里读**渲染出的**作品网格。**不读取** `document.cookie`、`localStorage`、
  请求头或设备/签名状态。
- **RSS**：按你授权的站点直接抓取 feed 原文，正文存结构（`content:encoded`），不存摘要代替正文。

### 4.2 升级说明（给用户）

- **商店版**：浏览器自动更新，无需操作。
- **GitHub Releases / 解压安装版**：下载新的 `chorus-vX.X.X.zip`，解压后**覆盖原目录**，
  再到 `chrome://extensions/` 点该扩展的「重新加载」。**本地数据不受影响**：数据库在
  IndexedDB 里，与扩展目录无关；覆盖前建议在「设置 → 下载 JSON 备份」留一份备份
  （这也是跨设备迁移的唯一路径）。
- **降级不受支持**：数据库迁移是单向的（Dexie 版本只升不降）。从新版本回退到旧版本可能
  读到无法识别的结构，届时请用备份恢复。

### 4.3 抖音的能力边界（必须如实写，不要美化）

- 抖音**没有**「追踪任意创作者」的官方 API：开放平台的 `video.list` 只能读**授权用户本人**的作品。
  所以本项目**不调用抖音官方接口**，也**不做签名算法**（`a_bogus`/`X-Bogus` 一类，社区方案
  需要持续维护且会静默失效）。
- 后果：抖音页面改版可能让采集暂时失效；**未登录**时平台只放出近期作品，深度回溯需要你已登录。
- **一个容易被误解的数字**：创作者主页标注的作品数**包含作者隐藏的作品**（已由用户确认，
  2026-09-11）。所以「实采数量少于标注数」是**预期现象**，不是故障，也不是「你要去登录」的信号。
  扩展会把这个差额当作真实情况报告，而**不会**报告成「同步成功 0 条」。
- 这条写进商店描述与 FAQ，能挡掉相当一部分「为什么少了 N 条」的差评。

### 4.4 X / Twitter 的能力边界

依赖网页客户端的内部接口与你当前的会话，平台调整（接口变更、风控收紧）会直接导致渠道暂时不可用，
常见表现是 429。扩展会在触发限流后**记住冷却**并跳过该平台，而不是继续打；恢复后自动可用。

---

## 5. 版本与发布策略

### 5.1 现状机制（已实现）

- **版本只有一处**：`package.json`。`wxt.config.ts` 刻意不覆盖 `manifest.version`，由 WXT 派生，
  所以清单、产物文件名、tag 三者不会互相矛盾。
- **发布靠 tag**：`vX.Y.Z` 触发 `release.yml`，它复跑全部门禁、校验 tag 与 `package.json` 一致、
  打包并发布 `chorus-vX.Y.Z.zip`。
- **门禁锁死一致性**：`e2e/release-gate.mjs` 的 `build.artifact` 断言
  `manifest.version === package.json.version`（**精确字符串相等**），作用是不让旧的 `.output/`
  被当成新构建放行。

### 5.2 商店带来的硬约束（这是策略必须处理的东西）

- 商店要求**版本严格递增**，且**一次被驳回的上传会占用那个版本号**——修好之后不能再传同一个号。
- Chrome 接受 1–4 段数字版本（每段 0–65535），所以行业惯例是**用第 4 位做重提交**，前三段不动。
- 于是有一个**当前机制解决不了的情况**：代码没变、只是商店页面被驳回要重提，也需要更大的版本号。
  而 `npm version` 只能产出三段 semver，且门禁断言的是精确相等。

### 5.3 建议的做法

**保留三段 semver 作为「产品版本」，第 4 位只作商店重提交计数。** 具体：

1. `package.json` 仍是唯一的产品版本来源，tag 仍是 `vX.Y.Z`，**日常发布完全不变**。
2. `wxt.config.ts` 增加一个**可选**的商店修订号：只在设置了环境变量（如 `CHORUS_STORE_REVISION=3`）
   时把清单版本写成 `X.Y.Z.3`；不设置时产物与今天**逐字节一致**。
3. `release-gate.mjs` 的 `build.artifact` 断言放宽为「前 3 段等于 `package.json`，允许可选第 4 段」。
   它真正的用途（挡住过期 `.output/`）不受影响。
4. **第 4 位不进 git tag、不改 GitHub 产物**：GitHub 上是 `v1.0.0`，商店上可能是 `1.0.0.3`，
   两者是同一个 commit。

代价：清单版本与 `package.json` 不再严格相等，是一处**有意的、只在商店路径生效的**例外。
替代方案（每次重提交都 `npm version patch`）会让产品版本被商店流程拖着走，
「1.0.7 被驳回、1.0.8 才是线上版」这种事实没有任何代码含义。

### 5.4 版本号语义（本项目约定）

| 位 | 什么时候加 | 本仓实例 |
|---|---|---|
| **MAJOR** | **不可回退的变更**：数据迁移后旧版读不了、备份格式破坏、需要用户手动干预。降级不受支持（Dexie 只升不降），所以这条必须慎用 | v5 迁移（清理已存推文）属这一级 |
| **MINOR** | 新增平台、新增用户可见能力 | 加 RSS、加深度回溯 |
| **PATCH** | 解析修复、缺陷修复、文案与文档 | Twitter 注入路径修复、RSS 正文修复 |
| **第 4 位** | **仅**商店重提交（被驳回，或只改商店页面）。代码与 tag 都不变 | — |

### 5.5 节奏建议

- **发版以 GitHub 为主**，tag 即发布；商店版本**挑选着同步**，不必每个 patch 都上架——
  但一旦上架，商店版的落后幅度要有个上限（例如不超过一个 MINOR），否则两拨用户的
  「已知问题」会分叉，问题反馈会对不上代码。
- **紧急修复只走 GitHub**，不走商店等待审核；这不是放弃商店用户，而是让他们用上一个可用的版本，
  等修复通过审核再补齐。

## 6. 上架后仍需维护的事

- 每次平台侧改版后，**商店描述的「已知限制」段可能需要跟着改**——描述里承诺的能力与产物必须一致。
- 权限有增减时，本文件 §3 与 `PRIVACY.md` §2 必须同一提交内更新，否则就是第二份对不上的权限表。
- 抖音相关的结论若发生变化（例如官方开放了需要的接口），优先更新
  `DOUYIN_RESEARCH_2026-09.md`，再改这里与商店描述。
