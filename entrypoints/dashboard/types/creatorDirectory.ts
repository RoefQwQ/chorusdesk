import type { Channel, Creator } from '../../../src/types';

/**
 * 创作者目录三套视图（网格 / 紧凑列表 / 详细卡片）共用的契约。
 *
 * 三套视图渲染同一份数据、触发同一批动作，差别只在排布方式。接口在这里定义一次、
 * 各视图 `extends` 组合，避免同一份定义被复制三遍，也避免三套视图对同一动作的命名
 * 逐渐漂移。
 *
 * 每个动作都只是「上抛」：真正的落点在 `CreatorsView` → `App.vue`，这一层不碰
 * 数据库、同步或弹窗。
 */

/**
 * 排序键。
 *
 * `platform` 与 `manual` 不是列 —— 它们是只有工具栏下拉能表达的顺序，所以这个联合比
 * 可排序表头更宽。点击表头只是写这同一份状态，而不是另立一套「顺序」概念，这正是
 * 下拉与表头箭头永远不会互相矛盾的原因。
 */
export type CreatorSortKey =
  | 'updated'
  | 'posts'
  | 'channels'
  | 'name'
  | 'tags'
  | 'platform'
  | 'manual';

/** 创作者 / 账号级别的动作。 */
export interface CreatorDirectoryActions {
  /** 给该创作者绑定一个新平台账号（打开新增弹窗的 channel 模式）。 */
  onAddChannel: (creator: Creator) => void;
  /** 更换主头像（打开头像选择弹窗）。 */
  onAvatarPicker: (creator: Creator) => void;
  /** 打开深度回溯弹窗；带 `channelId` 时只回溯该账号。 */
  onDeepSync: (creator: Creator, channelId?: string) => void;
  /** 编辑该创作者的标签。 */
  onEditTags: (creator: Creator) => void;
  /** 同步该创作者的全部账号。 */
  onRefreshCreator: (creatorId: string) => void;
  /** 同步单个账号；`force` 为强制刷新（忽略水位线）。 */
  onRefreshChannel: (channel: Channel, force: boolean) => void;
  /** 移除创作者（含其账号与动态）。 */
  onDeleteCreator: (creatorId: string) => void;
  /** 解绑单个账号。 */
  onDeleteChannel: (channelId: string) => void;
  /** 循环切换账号角色（主账号 → 小号 → 里号 → 自定义）。 */
  onCycleRole: (channel: Channel) => void;
}

/** 单个创作者的同步健康聚合（列表、网格与详细卡片的同步状态共用）。 */
export interface CreatorSyncSummary {
  /** 该创作者名下账号总数。 */
  total: number;
  /** 是否存在同步失败的账号。 */
  hasError: boolean;
  /** 失败账号数。 */
  errorCount: number;
  /** 第一个失败账号（用于 hover 展示错误原因）。 */
  firstErrorChannel?: Channel;
  /** 该创作者或名下任一账号正在同步。 */
  isUpdating: boolean;
  /** 名下账号最近一次同步时间，取最大值；从未同步为 0。 */
  lastCheckAt: number;
}

/**
 * 展示辅助。
 *
 * 这些是纯函数（读取视图层的 channels / 头像失败集合），由视图构造一次后传给三套视图，
 * 而不是让每套视图各实现一份 —— 同一个「主头像取谁」「最近同步怎么算」只能有一个答案。
 */
export interface CreatorDirectoryPresentation {
  /** 全部平台账号。 */
  channels: Channel[];
  /** creatorId -> 作品数。 */
  postCountMap: Record<string, number>;
  /** 正在单账号同步中的账号 ID 集合。 */
  syncingChannelIds?: Set<string>;
  /** 按平台分组的该创作者账号（网格徽章与详细卡片的分组区块都读它）。 */
  groupedChannels: (creatorId: string) => Record<string, Channel[]>;
  /** 该创作者的同步健康聚合。 */
  syncSummary: (creatorId: string) => CreatorSyncSummary;
  /** 相对时间文案（「3分钟前」/「未同步」）。 */
  relativeTime: (timestamp?: number) => string;
  /** 主头像 URL（档案头像 → 首个带头像的账号 → 空串）。 */
  creatorAvatar: (creator?: Creator | null) => string;
  /** 头像加载失败：记入失败集合，之后回退首字母。 */
  onAvatarError: (url?: string) => void;
}

/** 卡片与表格行共用的交互状态（勾选、展开、拖拽、标签三态）。 */
export interface CreatorDirectoryInteraction {
  /** 批量模式：卡片/行显示勾选框。 */
  isBatchMode: boolean;
  /** 已勾选的创作者 ID。 */
  selectedIds: Set<string>;
  /** 已展开账号列表的创作者 ID。 */
  expandedIds: Set<string>;
  /** 手动排序模式下拖拽经过的创作者 ID。 */
  dragOverId: string | null;
  /** 当前排序键（决定卡片是否可拖拽、表头箭头指向哪一列）。 */
  sortBy: CreatorSortKey;

  /** 展开/收起账号列表；列表视图里点击行内空白处也走它。 */
  onToggleExpand: (creatorId: string) => void;
  /** 手动排序拖拽。 */
  onDragStart: (creatorId: string) => void;
  onDragOver: (event: DragEvent, creatorId: string) => void;
  onDragLeave: (creatorId: string) => void;
  onDrop: (creatorId: string) => void;
  onDragEnd: () => void;
  /** 勾选/取消勾选单个创作者。 */
  onToggleSelect: (creatorId: string) => void;
  /** 点击标签芯片（三态过滤：中性 → 正向包含 → 反向排除）。 */
  onCycleTag: (tag: string) => void;
}

/** 网格与详细视图共用的契约（两者都是「masonry 分列 + 卡片」）。 */
export interface CreatorCardViewContext
  extends CreatorDirectoryActions,
    CreatorDirectoryPresentation,
    CreatorDirectoryInteraction {
  /** 已分好列的创作者（列数随窗口宽度变化，展开某列卡片不影响其他列）。 */
  columns: Creator[][];
}

/** 紧凑列表视图的契约：在共用部分之上再加表格特有的排序表头与批量入口。 */
export interface CreatorListViewContext
  extends CreatorDirectoryActions,
    CreatorDirectoryPresentation,
    CreatorDirectoryInteraction {
  /** 已筛选并排序后的创作者（视图侧 `filteredCreatorsList` 的值）。 */
  creators: Creator[];
  /** 当前排序方向（表头箭头与 `aria-sort` 都读它）。 */
  sortDir: 'asc' | 'desc';
  /** 表头排序状态查询与切换。 */
  isSortedBy: (key: CreatorSortKey) => boolean;
  ariaSortFor: (key: CreatorSortKey) => 'ascending' | 'descending' | 'none';
  onToggleSort: (key: CreatorSortKey) => void;
  /** 点击行内空白处切换展开（含「拖选文字」「拖拽收尾」两种例外）。 */
  onRowClick: (event: MouseEvent, creatorId: string) => void;
  /** 表头全选当前筛选结果。 */
  onSelectAll: () => void;
}
