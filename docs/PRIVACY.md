# 数据与隐私说明

Chorus 是一款本地运行的开源浏览器扩展，不设云端服务器，也不收集或回传任何用户数据。

---

## 1. 隐私原则

- **无自建后端**：扩展没有云端中转服务器。所有请求解析、动态去重与界面展示逻辑均在本地浏览器环境中执行。
- **无统计埋点**：代码中不包含任何第三方统计分析（如 Google Analytics、Sentry、Umami 等）脚本。
- **无需明文密码**：扩展不要求用户输入各平台的账号密码，通过浏览器内置的 Cookie 机制复用你当前已有的登录状态，且 Cookie 只会直接发送给对应平台的官方服务器。
- **数据完全由用户掌控**：关注列表、动态数据和设置全部保存在浏览器本地的 IndexedDB 与 Chrome Storage 中，随时可以导出备份或一键清空。

---

## 2. 权限说明

扩展在 `manifest.json` 中申请的权限如下：

| 权限名 | 类型 | 用途 |
|:---|:---|:---|
| `cookies` | 敏感权限 | 读取用户在对应官方平台已登录的 Session Cookie，用于向官方接口发起动态同步请求。 |
| `activeTab` | 交互权限 | 在创作者主页点击扩展图标时，获取当前标签页的网址与标题，用于自动解析创作者信息。仅在点击图标后临时生效，且只作用于当前标签页。 |
| `scripting` | 辅助权限 | 点击关注弹窗时，在当前页面运行简短提取脚本，获取页面上公开展示的昵称与头像链接；抖音同步时向已打开的抖音标签页注入只读采集脚本。 |
| `storage` | 存储权限 | 保存用户的界面偏好（如暗黑模式、自动同步间隔、过滤选项）。 |
| `alarms` | 定时任务 | 注册浏览器定时闹钟（默认每 30 分钟一次），在后台检查是否有新动态并更新图标角标。 |
| `declarativeNetRequestWithHostAccess` | 网络过滤 | 处理部分外部图片（如 B站、Pixiv、微博、小红书）的 Referer 请求头，避免第三方防盗链导致图片加载失败。规则只在扩展自身发起请求、且拥有对应站点 host 权限时生效。 |
| `host_permissions` | 跨域权限 | 允许 Background Service Worker 直接向各支持平台的官方 API 发起请求，避开浏览器的 CORS 跨域限制。清单由平台域名清单派生，只覆盖支持的平台。 |
| `optional_host_permissions` | 按需跨域 | RSS 源站由用户自行填写，无法预先列举。**安装时不授予任何站点**；仅当用户同步某个 RSS 账号时，浏览器才就该站点单独询问一次。 |

> 扩展**不申请** `tabs` 权限：判断某标签页是否属于抖音/推特时读取的标签页网址由对应平台的
> host 权限覆盖；Popup 读取当前标签页网址由 `activeTab` 在点击图标时提供。

---

## 3. 本地存储结构

数据存储在浏览器的本地沙箱中：

```text
浏览器本地存储
├─ IndexedDB (Dexie)，库名 CreatorFeedHubDB
│   ├─ creators: 创作者名片、主头像、自定义标签
│   ├─ channels: 绑定的平台账号、角色与同步状态
│   ├─ posts: 动态缓存、媒体链接、发布时间、已读与收藏（以 0|1 存储）
│   ├─ settings: 界面主题、同步间隔等配置（键 app_settings）
│   └─ deletedPostIds: 已删除动态的墓碑（含完整快照，用于回收站还原）
├─ IndexedDB，库名 FeedHubFSCache（与业务库分开）
│   └─ handles: 本地图片缓存目录的句柄
├─ localStorage（仅 dashboard 页面）
│   ├─ creator_feed_theme: 明暗主题
│   └─ creator_feed_hidden_creators / creator_feed_hidden_platforms: 隐藏偏好
├─ chrome.storage.session（仅内存，关闭浏览器即清空）
│   └─ 开发者日志：最多 150 条运行记录，不写入磁盘、不参与备份导出
└─ 本地文件系统 (可选)
    └─ FileSystem Access API: 本地离线保存的图片文件
```

> 没有独立的统计表：`getDatabaseStats()` 在调用时按需统计各表行数。
> 业务数据只存在于上表列出的位置；`chrome.storage.local` 已不再存放设置。

项目代码完全开源，可以在仓库中直接查看所有网络请求与存储逻辑。
