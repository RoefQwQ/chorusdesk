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

### 2.9 通用 RSS / Atom
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
