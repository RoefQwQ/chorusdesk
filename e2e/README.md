# E2E / real-browser probes

在**真实 Chrome 宿主**里验证扩展行为的脚本。不属于构建，不属于单元测试套件。
`release-gate.mjs` 是发布门禁（`release.yml` 会跑）；`creators-render.mjs` 是重构期的
渲染对比工具；其余为按需手跑的一次性探针。

## 依赖

`release-gate.mjs` 与 `creators-render.mjs` **零依赖**（用 Node ≥22 自带的全局 `WebSocket`），
无需 `npm install`。两个老探针需要 `ws`：`cd e2e && npm install`。

## 约束（先读这段）

- 只开**独立 profile** 的专用实例，绝不指向用户正在浏览的 Chrome（`AGENTS.md` 规则 25）。
- 探针只读；`release-gate.mjs` 会写自己的临时 profile（会自动创建、退出时删除），不碰任何既有数据。
- Chrome 152 起 `--load-extension` 被忽略。加载构建产物必须走 CDP，且必须带
  `--enable-unsafe-extension-debugging`，否则 `Extensions.loadUnpacked` 报
  `Method not available`（`AGENTS.md` 规则 28）。

## `release-gate.mjs` — 发布前门禁（推荐入口）

把 2026-09-11 手跑的三项验证固化为可重复的脚本，并接进 `.github/workflows/release.yml`：
**构建产物加载 → 备份导出/导入往返 → 自动同步 alarm 存活**。

```bash
npm run build            # 门禁读 .output/chrome-mv3，必须是最新构建
npm run e2e              # 或 node e2e/release-gate.mjs
```

它自己启动 Chrome（`--remote-debugging-port=0`，端口从 `DevToolsActivePort` 读）、
自己加载扩展、自己在页面上用**真实鼠标事件**点击、自己收尾（关浏览器 + 删 profile）。
Linux/CI 无显示环境用 `xvfb-run -a node e2e/release-gate.mjs`。

```text
  --extension <dir>   构建产物目录（默认 .output/chrome-mv3）
  --chrome <path>     Chrome 可执行文件（默认 CHROME_PATH，再退到各平台常见安装路径）
  --timeout <ms>      整轮看门狗，默认 240000
  --keep-profile      保留临时 profile 并打印路径（排查用）
  --verbose           附带页面 console 与逐步细节
```

检查项（`pass` / `FAIL` / `skip` 三态；`skip` 会在末尾列出原因，不会被算成通过）：

| 步骤 | 断言的东西 |
|---|---|
| `build.artifact` | 产物存在，且 manifest 版本 == `package.json`（防止拿旧 `.output` 放行） |
| `host.launch` / `host.load-extension` | Chrome 起得来、扩展加载成功并拿到 id |
| `dashboard.mounts` | dashboard.html 是真实扩展页（`chrome.runtime.id` 与加载 id 一致）且应用挂载 |
| `backup.arm-downloads` / `seed-fixture` | 下载目录已接管；固定 fixture 经**真实 file input** 导入并落库 |
| `backup.export` | 点「下载 JSON 备份」产生真实文件：文件名、`version: '1.0'`、四个 section |
| `backup.import-export-lossless` | 导出的 creators/channels/posts 与导入的 fixture **逐字节等价** |
| `backup.destroy` / `reimport-restores` | 清库后把导出的文件交回真实 input，行与设置都还原 |
| `alarm.enable-auto-sync` | 拨开关后设置确实落库，且 worker 建立了 30 分钟周期 alarm |
| `alarm.survives-popup-opens` | 连开 3 次 popup，`scheduledTime` 不变 |
| `alarm.survives-worker-restart` | **把 worker 冷停再唤醒**（`ServiceWorker.stopWorker`），`scheduledTime` 不变 |
| `alarm.scheduled-time-unchanged` | 三次读数一致（Δ 0 ms） |
| `alarm.cleared-when-disabled` | 关掉开关后 alarm 被清除 |

两个容易踩的点，已经写进脚本：

- **导入成功路径会 `alert()`**，它阻塞渲染进程并连带阻塞 CDP。脚本对每个页面会话都先
  `Page.enable` 并自动应答 `Page.javascriptDialogOpening`。
- **`ServiceWorker` 域只在页面会话上暴露**；在浏览器会话上调 `ServiceWorker.enable` 会得到
  `'ServiceWorker.enable' wasn't found`。同理 `chrome.alarms.getAll()` 只能在扩展自己的
  service worker target 里求值。

不跨浏览器重启留存（重启后重新加载等同全新安装），所以 **alarm 跨重启行为在这里仍不可验**。

## `creators-render.mjs` — 重构前后渲染对比（捕获 + 对比）

**不是测试，不进 CI**。只回答一个问题：改 `CreatorsView` 时「有没有任何可观察的变化」。

它加载构建产物、经**真实备份导入路径**播种固定 fixture（4 创作者 / 6 账号 / 6 动态，含角色、
标签、报错账号、无账号创作者），再按脚本化顺序驱动交互（三视图切换、5 个表头排序与方向翻转、
平台/角色/三态标签筛选、搜索、展开行、批量模式、手动排序拖拽），逐步记录创作者区块的
`outerHTML`：

```bash
npm run build
node e2e/creators-render.mjs capture /tmp/before.json
# …改视图…
node e2e/creators-render.mjs capture /tmp/after.json
node e2e/creators-render.mjs diff /tmp/before.json /tmp/after.json   # 有差异则退出码 1
```

`capture` 每步都断言后置条件（渲染出的「N / M 位创作者」计数、`aria-sort` 方向、全选计数）
以及拖拽后的落库顺序，**否则一次没点到的点击会让整个对比变得毫无意义**（`AGENTS.md` 规则 26）。
两个选择器陷阱也已写进脚本头：查询必须限定在创作者区块内（仪表盘会同时保留其他视图的 DOM，
FeedView 的标签芯片标题几乎一字之差），搜索框必须按 placeholder 定位。

Chrome 路径可用 `--chrome <path>` 或 `CHROME_PATH` 指定；profile 自建自删，不碰任何正在运行的浏览器。

## 一次性探针

### `douyin-probe.mjs` — 抖音创作者页面结构探针

验证采集器依赖的页面事实：登录面板状态、作品总数候选元素、作品网格与真实滚动容器、驱动滚动后的网格增长与声明总数对比。结果同时打印到 stdout 并写入 `[out.json]`（默认 `e2e/probe-result.json`，该文件按 `.gitignore` 不入库——它是本机一次实测的产物，不是仓库内容）。

```bash
cd e2e && npm install          # 仅这两个探针需要 ws
node douyin-probe.mjs <douyin-page-ws-url> [out.json]
```

### `drive-extension.mjs` — 扩展数据流驱动

在 dashboard 页面上下文里用原生 IndexedDB 读取扩展的 channels/posts，核对抖音渠道的游标状态与落库数量。

```bash
node drive-extension.mjs <dashboard-ws-url>
```

这两个探针按需手跑（连接已有的调试实例，参数是目标页面的 ws 地址）。`release-gate.mjs` 不使用
`ws` 包——它用 Node ≥22 自带的全局 `WebSocket`，这样 CI 里不需要任何安装步骤。
