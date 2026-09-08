# Chorus 阶段性修复汇报 — 2026-09

## 阶段结论

本阶段完成 2026-09 代码审查的修复队列 1–12，覆盖安全边界、数据正确性、
自动同步、备份恢复、查询性能、UI 可访问性和 CI。

相关提交：

- `25b8217` — 队列 1–4：后台请求安全、发送者验证、IndexedDB 迁移和自动同步。
- `03cb18e` — 队列 5–12：DNR、adapter 数据完整性、备份校验、结构化错误、索引查询、分层、UI 和 CI。

文件夹插件构建目录：

```text
.output/chrome-mv3
```

## 已完成内容

### 安全边界

- 使用解析后的 hostname 判断平台身份，不再使用 URL 子字符串匹配。
- 平台 host 是凭据白名单；任意 RSS URL 仍可访问，但不会携带浏览器凭据。
- 特权 runtime message 由 background 的集中策略表验证发送者；未知消息默认拒绝。
- 后台 fetch 限制为 GET，调用方不能选择 credential policy。
- DNR 规则只作用于扩展发起的请求，并移除 subframe 范围。
- 非 HTTP(S) URL 和包含内嵌凭据的 URL 被拒绝。

### IndexedDB 与自动同步

- `isRead` / `isBookmarked` 统一存储为 `0 | 1`。
- Dexie v4 migration 覆盖 posts 和 recycle-bin snapshots。
- unread badge 和 bookmark 统计使用可索引数值查询。
- alarm 初始化不会在 Service Worker 正常唤醒时重置周期。
- Service Worker 直接调用后台 fetch 实现，不向自身 message listener 发送请求。
- 自动同步复用批量限速流程。

### Adapter 数据完整性

- 删除随机 Post ID；没有稳定身份的数据直接跳过。
- 防止缺失 ID 生成碰撞键。
- RSS 使用支持 Unicode 的 UTF-8 稳定哈希。
- 解析日期在持久化前经过有限数值检查。
- `buildPost` 统一 13 处重复 Post 构建逻辑并固定 `isRead: 0`。

### 备份恢复

- 校验备份版本、顶层 section 类型和记录关键身份字段。
- 不兼容版本显示文件版本与当前支持版本。
- 最多列出前五条坏记录。
- 任一记录无效即在数据库写入前整体拒绝。
- 仍允许旧流程支持的部分 section 缺失。

### 结构化错误

- Adapter 使用结构化 `FetchError { code, message, retryable }`。
- 同步层按错误 code 决策，不再解析本地化错误文本。
- 超时、认证、限流、网络、解析、未找到和不支持平台可以区分。
- 未知平台不再静默回退到 RSS。
- 历史同步只有收到明确 `hasMore === false` 才确认结束。

### 查询性能和分层

- 水位线使用 `[channelId+publishedAt]` 复合索引 `.last()`。
- tombstone 查询使用 `channelId` 索引。
- Bilibili 去重改为按 channel 流式扫描。
- popup 写入使用 creator/channel application services。
- 平台 cookie 登录检测单一来源化。
- 删除零调用的 application facade。
- `useDeletedPosts` 通过 repository 清空回收站。

### UI

- 六个 dashboard modal 使用共享 `BaseModal`。
- BaseModal 提供 dialog semantics、Escape、焦点圈定、焦点恢复和 body scroll lock。
- 不同 modal 的 backdrop 关闭行为保持原有语义。
- `CreatorsView.vue` 从 1420 行缩减到约 1100 行。
- 提取 `PlatformBadge`、`ChannelRow` 和 `CreatorCardHeader`。

### CI 与测试

GitHub Actions 执行：

```text
npm ci
npm run typecheck
npm test
npm run build
```

当前验证：

| 项目 | 结果 |
|---|---|
| TypeScript | 通过 |
| Vitest | 5 个测试文件，37/37 通过 |
| Production build | 通过 |
| Vue SFC compilation | 通过 |
| 新组件 SSR render | 通过 |
| TypeScript 版本 | 固定为 7.0.2 |

测试覆盖 hostname/sender policy、结构化错误、Post 工厂、备份验证和提取后的 UI 组件渲染。

## 尚需人工验证

自动化浏览器 relay 在本阶段不可用，因此下列行为需要在真实 Chrome 文件夹插件中验证：

1. Service Worker 控制台无初始化异常。
2. Grid、List、Detailed 三种创作者视图均正常显示。
3. 作品数、平台徽章、账号头像和账号展开区正确。
4. 六个 modal 的 Tab、Shift+Tab、Escape、backdrop 和滚动锁正确。
5. 微博、Pixiv、小红书等媒体资源正常加载。
6. Bilibili、微博、Pixiv、小红书和 RSS 手动同步正常。
7. Rplay 凭据同步和 Twitter 页面会话同步正常。
8. unread badge 和 bookmark 统计正确。
9. 备份导出后可以原样导入；修改版本后会被拒绝。
10. 自动同步 alarm 存在，多次打开 popup 不会重置 scheduled time。

加载目录：

```text
.output/chrome-mv3
```

## 已知后续工作

- `CreatorsView.vue` 仍是大组件。后续应继续提取 toolbar、grid、list 和 detailed 子视图。
- 部分 adapter 的宽范围 catch 仍可能把解析或认证问题归类为通用网络错误。
- 备份验证尚未检查全部字段类型和跨表引用完整性。
- 嵌套 modal 场景尚未引入 modal stack。
- ESLint 尚未配置；CI 当前以 typecheck、tests 和 production build 为门禁。
- 私有或未公开的平台 API 可能随服务端更新变化。

## 仓库隐私状态

- `.output`、`.wxt`、`.e2e-profile`、日志、数据库、备份导出、环境文件和私钥格式均由 `.gitignore` 排除。
- 已跟踪源码中未发现个人 Cookie、session token、API key、密码或私钥。
- Git 历史保留现有作者邮箱；按当前决定不重写历史。未来提交改用 GitHub noreply 邮箱。
