import type { Channel, Creator } from '../../../src/types';

/**
 * 创作者目录三套视图（网格 / 紧凑列表 / 详细卡片）共用的动作契约。
 *
 * 三套视图渲染的是同一份数据、触发同一批动作，差别只在排布方式。把动作在这里
 * 定义一次，视图组件各自 `extends` 它，可以避免同一个接口被复制三遍、也避免三套
 * 视图对同一动作的命名逐渐漂移。
 *
 * 每个动作都只是「上抛」：真正的落点在 `CreatorsView` → `App.vue`，这一层不碰
 * 数据库、同步或弹窗。
 */
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

/** 单个创作者的同步健康聚合（列表与卡片的「同步状态」列共用）。 */
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
