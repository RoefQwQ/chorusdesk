# E2E / real-browser probes

一次性 CDP 探针脚本，用于在真实 Chrome 中验证扩展行为。不属于 CI，不属于构建。

## 前置

```bash
cd e2e && npm install   # 仅安装 ws
```

以远程调试端口启动（或复用已有的）Chrome，拿到目标页面的 `ws://…/devtools/page/<id>` 地址：

```bash
# 页面列表: http://127.0.0.1:9222/json
```

## 脚本

### `douyin-probe.mjs` — 抖音创作者页面结构探针

验证采集器依赖的页面事实：登录面板状态、作品总数候选元素、作品网格与真实滚动容器、驱动滚动后的网格增长与声明总数对比。`e2e/probe-result.json` 是它的一次输出样例（匿名访问，18/29 篇截断）。

```bash
node douyin-probe.mjs <douyin-page-ws-url> [out.json]
```

### `drive-extension.mjs` — 扩展数据流驱动

在 dashboard 页面上下文里用原生 IndexedDB 读取扩展的 channels/posts，核对抖音渠道的游标状态与落库数量。

```bash
node drive-extension.mjs <dashboard-ws-url>
```

## 约束

- 只读探针：不点击、不提交、不修改扩展数据（drive-extension 仅 `readonly` 事务）。
- 不得指向用户日常浏览的 Chrome 实例；使用独立的调试 profile。
