# Deletion domain — 状态模型与不变量（设计稿，未实现）

> **状态：设计稿。尚未写任何生产代码。** 本文件先于 schema 存在，理由见 §7。
>
> 背景：[`AUDIT_2026-09-12.md`](AUDIT_2026-09-12.md) §2 的 P0-1…P0-5。**本文件是那些条目的设计前置**，
> 不是它们的替代。
>
> **用户已定的产品决策（2026-09-12）**：
> 取关一个创作者后再重新关注，此前删掉的动态 **不回来**。
> 这一条决定了 suppression 的身份必须**跨 channel 重建存活**，见 §3。

---

## 1. 为什么不能直接开工

一份外部审查拦下了上一版设计，理由是准确的：

> 为了修一个「领域模型没想清楚」的问题，又快速实现了一个「新的领域模型还没想清楚」的解决方案。

**被拦下的具体错误**：上一版写的是「suppression（永久，**只增不减**）」。这个表述会制造一个
新的、更滑稽的缺陷：

```
用户点「恢复」 → post 回到 feed          ✓
             → 但 suppression 只增不减，仍在
下一轮同步    → channelSync 按 suppression 过滤 → 它又被滤掉
```

**「恢复」变成一场延迟生效的删除。** 比当前缺陷更糟：现在是「删了会回来」，那会变成
**「恢复了会消失」**。

**正确语义**：

> suppression 独立于回收站生命周期，**只有明确的「恢复 / 解除抑制」操作能删除它**。

| 操作 | post | suppression | snapshot |
|---|---|---|---|
| 删除 | 删除 | **创建** | **创建** |
| 彻底删除（清快照） | 删除 | **保留** | 删除 |
| 清空回收站 | 全部删除 | **全部保留** | 全部删除 |
| 恢复该动态 | **创建** | **删除** | 删除 |
| 全部恢复 | 全部创建 | **全部删除** | 全部删除 |
| 备份 / 导入 | 随文件 | **随文件** | 随文件 |

**「只增不减」被明确否决**：它把三个动词（删除 / 彻底删除 / 恢复）压成了一个终态。

---

## 2. 三个概念，三套生命周期

当前 `deletedPostIds` **一行承担两职**，这是本次重做的根因（P0-1）。

| 概念 | 回答的问题 | 生命周期 | 谁删除它 |
|---|---|---|---|
| **Suppression** | 「这条内容不许通过同步再出现」 | **长**——跨取关、跨重装、跨改名 | **只有用户显式恢复** |
| **RecycleSnapshot** | 「这条内容还能不能找回」 | 短——用户清空即没了 | 彻底删除 / 清空回收站 / 恢复 |
| **Post** | 「现在可见的内容」 | 随同步增删 | 删除、清理旧动态 |

三者的**关系不是包含关系**：可以「有 suppression 没有 snapshot」（彻底删除之后），
也可以「有 post 没有 suppression」（正常同步来的、用户没删过）。

---

## 3. Suppression 的身份（本设计最关键的决定）

### 3.1 已核实的身份事实

| 事实 | 出处 |
|---|---|
| `Channel.id = \`${platform}:${accountId}\`` ——**它本身就是稳定身份，不是随机 uuid** | `useQuickFollow.ts:118`、`useCreatorsManager.ts:137` |
| `Post.id = \`<platform>_<平台原生 id>\``，如 `twitter_<tweetId>`、`xiaohongshu_<noteId>` | 各 adapter；`ARCHITECTURE.md` §4.1 有全表 |
| **但 Twitter 的 `accountId` 是 `username`** —— 用户改名，`channelId` 就变 | `urlParser.ts:91` |
| `Post.id` **不含 channelId** —— 同一条 tweet 的 id 在任何 channel 下都一样 | 各 adapter |

### 3.2 因此：身份取 `Post.id`，不取 `channelId`

**用户决策（取关后重新关注，删过的不回来）直接排除了按 `channelId` 绑定**：

```
关注 A(channelId = "twitter:alice") → 删掉 tweet T → suppression = {channelId: "twitter:alice"}
取关（channel 行删除）→ 重新关注 → channelId 仍是 "twitter:alice"（同名重建）
```

**看似可行，但两个反例**：

1. **改名**：`twitter:alice` → 用户改名为 `bob` → 重新关注得到 `twitter:bob`。
   按 `channelId` 绑定的 suppression **认不出来**，T 会回来。
2. **跨创作者**：同一条 tweet 被两个 Creator 绑定时（可能吗？见 §6 问题 3），
   按 `channelId` 绑定会得到两条互相独立的 suppression。

**结论**：

```ts
interface PostSuppression {
  postId: string;        // ← 主键。Post.id 已是全局唯一且不含 channelId
  platform: Platform;    // 从 postId 前缀可推，但显式存一份便于按平台查询与校验
  suppressedAt: number;  // 便于调试与排查（"这条为什么不同步"）
}
```

`postId` 就是稳定身份。**这也是当前实现里唯一没做错的部分**——`deletedPostIds` 的主键已经是
`post.id`，而 `channelId` 只是它携带的一个字段。**P0-1 是把携带的字段降级为"参考信息"，
不是换个绑定点。**

### 3.3 与 `deletePostAndTombstone` 的差异

当前 `deletePostAndTombstone(post)` 会把 `channelId` / `creatorId` / `platform` / `title` 一并写入。
`RecycleSnapshot` 里这些字段**有用**（回收站列表要显示"来自哪个账号"、要能按频道筛）。
所以：

- **`RecycleSnapshot` 保留** `channelId` / `creatorId` / `title` / `deletedAt` 等展示信息；
- **`PostSuppression` 只留** `postId` + `platform` + `suppressedAt`。

**两个表，因为它俩的生命周期不同**（外部审查倾向的方案 A）。方案 B（一表加 `suppressed` 标志）
迁移成本低，但会让「只删快照、保留抑制」变成一次 `UPDATE`，而「恢复」要区分"删哪一半"——
**语义上比两张表更难读**。

---

## 4. 不变量（先于实现写，测试直接钉这些）

外部审查的建议，我采纳：**先写领域不变量，再写实现**。
「给现在这几个函数写 regression test」会随函数一起被删；不变量不会。

### 4.1 核心不变量

| # | 不变量 | 违反时的用户可见后果 |
|---|---|---|
| **I1** | 删除成功后：`post` 不存在 ∧ `suppression` 存在 ∧ `snapshot` 存在 | —— |
| **I2** | 彻底删除后：`post` 不存在 ∧ **`suppression` 仍存在** ∧ `snapshot` 不存在 | 删过的内容日后再从同步里冒出来 |
| **I3** | 清空回收站后：所有 `snapshot` 不存在 ∧ **所有 `suppression` 仍存在** | 同上，批量版 |
| **I4** | 显式恢复后：`post` 存在 ∧ **`suppression` 不存在** ∧ `snapshot` 不存在 | 「恢复了它又消失」 |
| **I5** | **`post` 与 `suppression` 不得同时存在**（就同一 id 而言） | 可见内容与"它被禁止"矛盾 |
| **I6** | 事务中任一步失败 → 不得留下半状态（I1/I4 要么全成要么全不成立） | 孤儿行 / 矛盾态 |
| **I7** | **普通同步永不写入仍受 suppression 的 post** | 删除失效 |
| **I8** | **suppression 在备份→清库→导入后语义与原库一致** | 迁移/重装后删除失效 |
| **I9** | `suppression` 一旦建立，**只能由显式恢复操作删除**；cascade 删除 creator/channel **不得**删除它 | 取关→重关后旧删除失效（用户已明确要求"不回来"） |

### 4.2 边界不变量（当前实现的缺陷所在）

| # | 不变量 | 现状 |
|---|---|---|
| **I10** | 墓碑读取失败时**不得继续落库**（fail closed） | **违反**：`channelSync.ts:322` 的 `catch {}` 放行（P0-2 的同源） |
| **I11** | 恢复时父实体（creator / channel）必须存在，或明确进入"待重绑"状态 | **违反**：`useDeletedPosts.ts:81` 不校验（P0-3） |
| **I12** | `snapshot` 的父实体被 cascade 删除时，该 snapshot 必须有明确归宿（删除或标记） | **违反**：cascade 事务不含墓碑表（P0-3） |

### 4.3 不变量如何被测试（必须能失败）

外部审查强调「不要只证明当前函数会 throw」。因此：

- 不变量测试**经公开入口**（`postService` / `channelSync` / `backupService`）观察，
  不直接调仓储内部函数——否则重构即失效；
- **故障注入**：让 `posts.put` / `suppression.delete` 按指令抛错，断言 I6 成立
  （不能留下半状态）；
- **每个不变量都要有变异验证**（规则 26）：改坏实现 → 该不变量必须失败 → 恢复后全绿。
  **一个从未红过的不变量测试，不能算证据。**

---

## 5. v5 → v6 迁移映射（提案，未实施）

### 5.1 现状

```ts
version(3): deletedPostIds 'id, channelId, creatorId, deletedAt'   // database.ts:63
```

一行同时是 suppression 与 snapshot（`postRepository.ts:33`）。

### 5.2 提案

```ts
// v6：拆表。两个 store 各自声明完整索引（Dexie 语义：新 version 全量替换）。
version(6).stores({
  // …v1–v5 的既有 store 原样重述（creators/channels/posts/settings）…
  postSuppressions: 'postId, platform, suppressedAt',
  recycleSnapshots: 'id, channelId, creatorId, deletedAt',
}).upgrade(async (tx) => {
  // 数据搬迁，规则：现有每一行 → 两表各一条（当前每一行都同时扮演两种角色）
  for (const row of await tx.table('deletedPostIds').toArray()) {
    await tx.table('postSuppressions').put({
      postId: row.id, platform: row.platform, suppressedAt: row.deletedAt,
    });
    await tx.table('recycleSnapshots').put({
      id: row.id, channelId: row.channelId, creatorId: row.creatorId,
      title: row.title, deletedAt: row.deletedAt, postData: row.postData,
    });
  }
  // deletedPostIds 保留还是删除？见 §6 问题 4
});
```

**搬迁规则的理由**：现状下每一行都同时是抑制与快照，所以一对一搬进两表是**无损**的。
没有推断，只是把一个已有的事实拆开写。

### 5.3 迁移必须遵守（`DEVELOPMENT.md` §4）

- 不删/不重排 v1–v5；
- v6 的 `.stores()` 必须重述**全部**受影响 store 的完整索引；
- 迁移 callback **导出给测试使用**（本仓库已在 v4/v5 这么做，理由是测试不该复制逻辑）；
- 旧数据默认兜底；导入旧备份仍可读。

### 5.4 迁移测试必须用生产 callback

`AGENTS.md` 规则 22：**声明自己的 upgrade 副本 = 测了个寂寞**。
v4 的测试是那样写的（为独立钉住 schema），**v6 的测试必须调用生产 callback**。

---

## 6. 未决问题（开工前必须回答）

外部审查列出的四个，加上我核对身份模型时发现的两个。

| # | 问题 | 影响 |
|---|---|---|
| **1** | **`deletedPostIds` 这张表在 v6 后留不留？** 留 = 有过渡期但两套并存（本仓库明令禁止维护两套）；删 = 迁移不可回退（Dexie 迁移是单向的，用户无法降级到 v5） | 决定迁移能否先发小步验证 |
| **2** | **`platform` 冗余存储 vs 从 `postId` 前缀推断？** 前缀推断无需迁移且不会漂移，但依赖 `_` 分隔的命名约定（`bilibili_video_<bvid>` 里有下划线）；冗余存储则要在迁移时从各行取值 | 决定索引形状 |
| **3** | **同一条 post 能否同时属于两个 channel？** ——**已核实：不能。** `posts` 主键是 `id`（`database.ts:54`），而 `Post.id` 不含 channelId（各 adapter），所以两个 channel 抓到同一条内容时，**后写的 `bulkPut` 直接覆盖前者的 `channelId`**。结论：`recycleSnapshots.channelId` 是单值的，键设计不受影响；但**覆盖意味着"这条动态来自哪个账号"会随同步顺序变化**，回收站列表的归属显示因此是"最近一次抓到它的账号"而非固定事实——文案上不宜说得太肯定 | 已解决，但暴露一个显示层的小事实 |
| **4** | **Twitter 改名（`accountId` = username）导致的 channelId 漂移，对 `recycleSnapshots.channelId` 意味着什么？** 快照的"来自哪个账号"会指向一个已不存在的 channel | 影响回收站列表的显示与筛选 |
| **5** | **取关时是否提示用户？** 用户已定"删过的不回来"，但取关那一刻 suppression **静默存活**——是否需要在取关确认框里告知"该创作者下你删过的 N 条仍保持删除状态" | 纯产品决策 |
| **6** | **`cleanupOldPosts`（60 天清理）与 suppression 的关系？** 它删的是"未收藏"的动态。被它删掉的动态**不应**建立 suppression（那是自动清理，不是用户意图）——需确认 | 避免把系统行为误记为用户意图 |

---

## 7. 实施顺序（本文件的用意）

```
① 本文件（状态表 + 不变量 + 迁移映射）        ← 现在在这里
        ↓  用户确认语义
② 不变量测试（先红：证明当前违反 I2/I3/I5/I10/I11/I12）
        ↓
③ Dexie v6 迁移 + 两表实现
        ↓
④ 备份纳入 suppression（AUDIT §6 的方案 A，格式 1.0 → 1.1）
        ↓
⑤ 恢复快照 / 合并导入 分离（P0-5）
```

**顺序不能颠倒**：③ 若在 ② 之前，实现会先固化我对语义的（可能错误的）理解——
这正是本文件存在的原因。④ 若在 ③ 之前，备份会先锁定一版即将改变的表结构。

**外部审查的原始措辞**（作为执行纪律）：

> 先让它交付一个很短的 deletion-domain 状态表 + invariants + v5→v6 migration mapping，
> 不写生产代码。确认这些语义后再做测试和 schema。

---

## 8. 与审计条目的对应

| 本文件 | 审计条目 |
|---|---|
| §2 三概念分离 | P0-1 |
| §4.2 I6 | P0-2 |
| §4.2 I11 / I12 | P0-3 |
| §4.1 I8 | P0-4（+ §6 方案 A） |
| §6 问题 1 | P0-5（恢复快照 vs 合并导入） |
| §4.2 I10 | P0-2 同源（`channelSync.ts:322` fail-open） |
