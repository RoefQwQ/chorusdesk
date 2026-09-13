# 小红书采集路径调查（2026-09-13）

> 背景：用户报告「更早的历史投稿无法获取」，此前一轮修复（`7505cf8` 把传输上限从 250k
> 提到 1M）让主页**能完整解析**，因此暴露了获取路径本身的问题。
>
> 本文只记录**实测**到的内容。凡是推断都标出来。与抖音为何不走 API 并列，
> 见 [`DOUYIN_RESEARCH_2026-09.md`](DOUYIN_RESEARCH_2026-09.md)。

---

## 1. 现状：一次同步只能拿到一屏

主页 `https://www.xiaohongshu.com/user/profile/<userId>` 的 SSR
`window.__INITIAL_STATE__` 里，`user.notes` 是一个**按标签分组的数组**，实测某真实账号为
**5 组、扁平化后 30 条**。

适配器现在的「历史挖掘」**不是平台分页**，而是对这 30 条做**本地偏移切片**：

```ts
const offset = isHistoryDig ? Math.max(Number(options?.cursor) || 0, 0) : 0;
const targetPosts = allPosts.slice(offset, offset + limit);
```

它每次深挖都**重新抓同一个主页**（同一个页面状态），因此 offset 走到 30 就必然到头。

## 2. 平台自己写着「还有更多」

同一份响应里，`user.noteQueries` 是一个 5 元数组（对应 5 个标签页），实测：

```json
{ "num": 30, "hasMore": true, "cursor": "69fdde80000000003701d75f", "page": 1 }
```

**`hasMore: true` 且带一个真实游标。** 相关字段还有 `user.isFetchingNotes`、
`user.pageScrolled`、`user.firstFetchNote`、`user.userNoteFetchingStatus` —— 这些是
**为无限滚动准备的状态**。

> **推断（未实测）**：这些字段意味着网页端确实是滚动加载的。但「滚动会不会加载出更多」
> **没有验证过**，因为匿名会话拿不到主页（见 §4）。这正是 `e2e/xhs-scroll-probe.mjs`
> 要回答的问题。

## 3. 已修的部分（`06c8a12`）：不再冒充平台说「到底」

适配器原先在 offset 耗尽时返回 `hasMore: false`，而 `statesEndOfHistory` 把它读成
**平台声明到底** → 写 `__END__` → 该频道**永久不再挖**（规则 10：误判「完整」不可恢复）。

现在改为返回 `error: unsupported` 并说明真实限制；同时**声明 `paginates: false`** ——
这是**让已经被写死 `__END__` 的频道能恢复**的关键：`hasStaleTerminalCursor` 只清理
「平台本就不声明游标」的那些标记。

**这只止血，没治病**：深挖仍只能拿到第一屏。

## 4. 登录墙：匿名会话拿不到创作者主页

实测：干净 profile 访问主页会被**重定向到登录页**。

```
location.href = https://www.xiaohongshu.com/login?redirectPath=…%2Fuser%2Fprofile%2F…
bodyText      = 「登录后推荐更懂你的笔记 … 扫码 … 登录」
笔记数        = 0
```

扩展能拿到 30 条，是因为 `bgFetch` 带 `credentials: 'include'`，用的是**用户的登录态**。

## 5. 反爬节流：同一 URL 的结果不稳定

对 `user/profile/<id>` 连续匿名请求，实测（2026-09-13）：

| 尝试 | 响应长度 | 笔记数 | noteQueries[0] |
|---|---|---|---|
| 1–3 | 35 829 | 0 | `hasMore: true, cursor: ""` |
| 4 | **222 812** | **30** | `hasMore: true, cursor: "69fdde80…"` |
| 5–10 | 35 829 | 0 | `hasMore: true, cursor: ""` |

**两个后果**：

1. **空壳响应不等于账号没内容**。35 829 字符那份里 `notes` 是五个空数组，
   而 `noteQueries` 依然写着 `hasMore: true`。判断「这个账号没作品」必须看别的信号。
2. **连匿名取证都不稳定**，所以不能拿单次结果下结论（规则 30：一次绿不算证据）。

## 6. 下一页接口需要签名

已知的网页接口是 `/api/sns/web/v1/user_posted`（参数 `user_id` / `cursor` / `num`），
实测裸调：

| 主机 | 结果 |
|---|---|
| `edith.xiaohongshu.com` | **HTTP 406** `{"code":-1,"success":false}` |
| `www.xiaohongshu.com` | **HTTP 500** `create invoker failed, service: jarvis-gateway-default` |

需要 `X-S` / `x-s-common` 签名头，**由页面里混淆的 JS 在运行时生成**。

这与抖音的 `a_bogus` 是**同一类**问题，而 [`DOUYIN_RESEARCH_2026-09.md`](DOUYIN_RESEARCH_2026-09.md)
已明确排除签名路线：

> 「一旦开始搬运签名与设备标识，这个扩展在技术定义上就变成……」
> 「结论：签名路线与项目定位不相容，明确排除。」

**因此「在页面里借它的环境算签名」这条路，需要用户明确推翻那条既定决定** ——
否则小红书与抖音会变成两套标准。

## 7. 两条可行路线与各自的前提

| | A. 页面驱动滚动 | B. 页内调签名接口 |
|---|---|---|
| 做法 | 注入函数滚动作品墙，读渲染后的 DOM | 注入函数，在页面上下文里请求 `user_posted` |
| 与现有定位 | **一致**（抖音 collector 同类，不碰签名） | **冲突**（签名路线，已在 DOUYIN_RESEARCH 排除） |
| 前提 | **必须先实测「滚动能否加载更多」**（需登录态） | 需推翻既定决定 |
| 已知代价 | 若改成页面驱动，`fetchLatest` 在 SW 里就跑不了 → 可能要声明 `backgroundSync: false` | — |

> 规避代价的办法（**未实现，仅为设计方向**）：正常同步保持现在的 `bgFetch` 路径，
> **只有带游标的深挖**走页面驱动。这样后台自动同步不受影响，只有 `paginates` 那条要改。

## 8. 工具

- `e2e/xhs-scroll-probe.mjs` —— 回答 §7 的 A 前提。驱动**所有**可滚动祖先与文档
  （规则 10：窗口往往不是滚动容器），等待渲染而非固定 sleep（规则 17）。
  需要登录态：`XHS_PROFILE=<已登录 profile 目录> node e2e/xhs-scroll-probe.mjs`。
- `e2e/avatar-probe.mjs` —— 通用「这一页的头像是什么」取证（同样独立 profile）。

## 9. 未验证清单（别当成已结论）

- 滚动是否真的加载出第 31 条之后的内容。**§2 的字段只是提示。**
- 主页 SSR 是否在某个条件下会带更多条（例如已登录、或访问 `?page=2`）。
  实测 `?cursor=` / `?page=2` **不改变**响应（仍是同一份 35 829 字符空壳）。
- `noteQueries` 那 5 个条目分别对应哪些标签页，以及非「笔记」标签是否可翻。
