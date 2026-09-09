# 平台支持与授权说明

Chorus 直接复用浏览器对应平台的已登录会话（Cookie / LocalStorage）或公开接口，不需要在扩展中输入或保存第三方账号密码。

---

## 1. 平台支持列表

| 平台 | 域名 | 鉴权方式 | 支持内容 | 深度历史回溯 | 图片防盗链处理 |
|:---|:---|:---|:---|:---:|:---:|
| 哔哩哔哩 | bilibili.com | 浏览器 Cookie | 图文动态、视频投稿、转发 | 支持 | declarativeNetRequest 处理 Referer |
| X (Twitter) | x.com | 浏览器 Cookie / 活跃标签页 | 原创推文、转发、图文、视频 | 支持 | 专用解析管道 |
| YouTube | youtube.com | 官方公开 RSS（无需登录） | 最新公开视频 | 仅最新批次 | 不需要 |
| Pixiv | pixiv.net | 浏览器 Cookie | 插画、漫画、系列作品 | 支持 | Background 图片代理服务 |
| Fantia | fantia.jp | 浏览器 Cookie | 俱乐部动态、已赞助会员附件 | 支持 | 自动处理鉴权头 |
| Rplay | rplay.live | 网页端 LocalStorage Token | 专栏图文、创作者更新 | 支持 | 不需要 |
| Withny | withny.fun | 浏览器 Cookie | 图文动态、赞助更新 | 支持 | 不需要 |
| 小红书 | xiaohongshu.com | 浏览器 Cookie | 图文笔记、视频笔记 | 支持 | 自动清洗 Referer |
| 微博 | weibo.com | 浏览器 Cookie | 原创微博、转发、九宫格图片、视频 | 支持 | 自动清洗 Referer |
| 抖音 | douyin.com | 已打开的抖音页面（不读取凭据） | 创作者短视频、图文作品 | 不支持 | 封面走 Background 图片代理 |
| 通用 RSS / Atom | 任意兼容 URL | 公开 XML 协议 | 博客、Substack 等通用订阅源 | 视源而定 | 不需要 |

---

## 2. 平台细节与注意事项

### 2.1 哔哩哔哩 (Bilibili)
- **鉴权**：读取浏览器现有的 `SESSDATA` 等 Cookie。
- **内容**：空间图文、投稿视频与转发。
- **防盗链**：B站图片 CDN（`*.hdslb.com`）校验 Referer。扩展通过 `declarativeNetRequest` 规则动态去除图片请求的来源头，使展台可直接加载原图。

### 2.2 X (Twitter)
- **鉴权**：通过当前浏览器 Twitter 网页端的会话凭证与官方 GraphQL 接口通信。
- **频率限制 (429)**：
  - 推特接口对高频请求限制严格。扩展在请求间加入了自适应延时和冷却机制。
  - 若遇频繁 429，可先在浏览器中打开目标博主的推特主页标签页，扩展会优先复用当前活跃标签页的前端网络会话。

### 2.3 YouTube
- **鉴权**：免登录。扩展将频道链接（如 `@channelname`）解析为 YouTube 官方提供的 XML 订阅源。
- **限制**：公开 XML 源仅返回最新的 15–30 条视频，不支持数年前的历史翻页回溯。

### 2.4 Pixiv
- **鉴权**：复用浏览器当前已登录的 Pixiv 会话（`PHPSESSID`）。
- **图片代理**：Pixiv 图片服务器（`i.pximg.net`）会拦截非站内 Referer。扩展内置了由 Background Service Worker 承接的图片安全代理服务（`proxyImage`），保证灯箱全屏原图可以正常加载。

### 2.5 Fantia
- **鉴权**：复用浏览器现有的 Fantia Cookie。
- **赞助内容**：如果你在网页端已加入该创作者的付费俱乐部，同步时可正常获取专享动态与图文附件；未赞助内容则呈现公开预览部分。

### 2.6 Rplay
- **鉴权**：Rplay 采用单页架构，会话凭证保存在网页端 LocalStorage 中。
- **同步方式**：扩展内包含一个轻量内容脚本（`rplay-sync.content.ts`）。日常浏览 Rplay 网站时，脚本会自动把当前的登录 Token 同步到扩展本地存储中，便于后续后台静默拉取。

### 2.7 小红书 (Xiaohongshu)
- **鉴权**：复用当前浏览器的小红书登录状态。
- **内容**：博主公开的图文笔记与视频笔记，提取正文、封面与多图图集。

### 2.8 微博 (Weibo)
- **鉴权**：复用微博网页端登录 Cookie。
- **内容**：抓取原创与转发微博，支持超长多图及视频。

### 2.9 抖音 (Douyin)

- **添加方式**：粘贴创作者主页链接 `https://www.douyin.com/user/<sec_uid>`。作品链接（`/video/...`、`/note/...`）无法确定作者身份，会被识别为作品链接并提示改用主页。
- **内容**：创作者公开的短视频与图文作品（标题/描述、封面、发布时间、话题标签）。
- **鉴权**：不读取、不保存任何抖音凭据。扩展不接触 Cookie、Token、请求头或设备指纹。
- **同步前置条件**：抖音的作品列表**只能在真实页面中加载**。后台直接请求主页只会得到反爬 JS 挑战页面（返回 200 但无任何作品数据），因此同步前需要在浏览器打开该创作者主页并保持标签页开启。
- **采集方式**：扩展通过 `chrome.scripting.executeScript` 把只读采集脚本注入已打开的抖音标签页，仅读取已渲染的 DOM，与 Twitter 的活跃标签页方案同源。
- **发布时间**：来自 `aweme_id` 本身（snowflake 高 32 位为秒级时间戳），不依赖页面上易变的日期文案。
- **去重**：以 `aweme_id` 作为唯一身份（Post ID 形如 `douyin_<aweme_id>`）。描述、封面或媒体地址变化不会产生重复作品。
- **视频播放**：抖音播放地址带签名且会过期，因此不做长期保存。卡片显示封面，点击跳转到稳定的作品页面。
- **深度历史回溯**：**不支持**。当前页面作品列表没有稳定可靠的翻页机制，强行分页会漏内容，因此明确返回“已到底”而不是伪造分页。
- **自动同步**：抖音需要真实页面参与，后台定时任务无法独立完成，会返回明确的不支持状态，不会显示成“同步成功 0 条”。

### 2.10 通用 RSS / Atom
- 支持导入任何标准 RSS 2.0、Atom 1.0 的 XML 链接。
- 可以配合 [RSSHub](https://docs.rsshub.app/) 将 Telegram 频道、Patreon、Substack 或播客等接入 Chorus 统一阅读。

---

## 3. 网络请求架构

由于浏览器同源策略（CORS），扩展的页面端（Popup 和 Dashboard）无法直接跨域向第三方社交平台发请求。

Chorus 的网络调用方式如下：

```text
[Dashboard / Popup 页面]
        │
        │ chrome.runtime.sendMessage({ type: 'BG_FETCH', url, options })
        ▼
[Background Service Worker]
        │
        │ 带有 host_permissions 权限，在后台发起 fetch 请求
        │ 自动携带目标平台的同域 Cookie
        ▼
[目标平台官方 API / CDN]
```

所有请求均直接发生在用户本地浏览器与目标平台服务器之间，不通过任何第三方中转服务器。

### 3.1 页面驱动采集（抖音）

抖音不走上面的 `BG_FETCH` 路径：后台请求创作者主页只会得到反爬 JS 挑战外壳，没有任何作品数据。抖音改为从真实页面采集：

```text
[Dashboard 页面]
        │
        │ chrome.runtime.sendMessage({ type: 'FETCH_DOUYIN_SNAPSHOT', secUid, limit })
        ▼
[Background Service Worker]
        │  校验发送方为扩展自身页面（sender policy）
        │  查找已打开的抖音标签页，并校验其 hostname 属于 douyin.com
        │  chrome.scripting.executeScript 注入只读采集脚本
        ▼
[已打开的抖音标签页]
        │  仅读取已渲染 DOM，不读取 Cookie / Token / 请求头
        ▼
[快照返回扩展]
        │  作为不可信输入进入校验层（normalizeSnapshot）
        ▼
[Post 写入本地数据库]
```

页面返回的所有数据都视为不可信输入：作品必须具备合法 `aweme_id` 与可用时间戳才会入库，媒体地址必须通过协议与 CDN 域名校验，否则整条或该字段被丢弃。
