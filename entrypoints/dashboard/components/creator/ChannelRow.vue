<script setup lang="ts">
import { computed } from 'vue';
import { History, RefreshCw, Trash2, AlertCircle, ExternalLink } from 'lucide-vue-next';
import { ACCOUNT_ROLE_BADGE_CLASS, ACCOUNT_ROLE_LABELS, PLATFORM_REGISTRY, type Channel } from '../../../../src/types';

/**
 * 创作者卡片内单个已绑定账号行：角色徽章（点击轮换）、平台链接、同步
 * 状态与行内操作（回溯 / 同步 / 移除）。原先在网格展开区与详细视图中
 * 内联三份且样式各异，此组件收敛为单一实现。
 *
 * 两种形态：
 * - `compact`（网格展开区）：小图标、无头像、错误信息折行展示；
 * - 默认（详细视图）：带账号头像、@ID、同步失败徽章与最近同步时间。
 */
const props = defineProps<{
  channel: Channel;
  /** 所属创作者（回溯入口需要上下文）。 */
  creatorId: string;
  /** 该账号是否正在同步（外层管集合，避免行内重复推导）。 */
  isSyncing?: boolean;
  /** 头像加载失败的 URL 集合（详细视图头像回退首字）。 */
  failedAvatarUrls?: Set<string>;
  /** 紧凑样式（网格展开区：更小的图标与内边距）。 */
  compact?: boolean;
}>();

/**
 * 账号行必须自报平台。
 *
 * 一位创作者常把同名账号绑到多个平台（B站与微博都叫「某某日记」），只显示
 * 角色徽章 + 昵称时，两行看起来完全一样，无法判断哪一行属于哪个平台——
 * 这正是「绑定账号只显示账号类型」造成的困惑。平台名与色点来自
 * `PLATFORM_REGISTRY`（平台元数据的单一来源）。
 */
const platformMeta = computed(() => PLATFORM_REGISTRY[props.channel.platform]);
const platformName = computed(() => platformMeta.value?.name || props.channel.platform);

/**
 * 最近一次同步时间。优先取成功时间，未成功过则退回最近一次检查时间——
 * `Channel` 没有 `lastSyncAt` 字段，此前模板读取它恒为 undefined，整个
 * 「上次同步」区块从未渲染过。
 */
const lastSyncAt = computed(() => props.channel.lastSuccessAt ?? props.channel.lastCheckAt);

/** 同步失败徽章点击后的详情弹窗（模板内无法直接调用 `alert`）。 */
function showSyncError() {
  const name = props.channel.displayName || props.channel.accountId;
  alert(`【${name} 同步未成功】\n\n原因：${props.channel.errorMessage || '未知异常'}`);
}

/**
 * 相对时间（与 CreatorsView.formatRelativeTime 同语义的本地实现）。
 */
function relativeTime(timestamp?: number): string {
  if (!timestamp) return '未同步';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min}分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day}天前`;
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

const emit = defineEmits<{
  (e: 'deep-sync', payload: { creatorId: string; channelId: string }): void;
  (e: 'refresh', payload: { channel: Channel; force: boolean }): void;
  (e: 'delete', channelId: string): void;
  (e: 'cycle-role', channel: Channel): void;
  (e: 'avatar-error', url?: string): void;
}>();
</script>

<template>
  <div
    class="rounded-lg bg-white dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 text-xs shadow-2xs"
    :class="compact ? 'p-1.5' : 'p-1.5 flex items-center justify-between'"
  >
    <!-- Compact mode keeps the row and its error banner stacked, but the row
         itself must still lay out horizontally: without this wrapper the button
         group was a block sibling of the label and wrapped onto its own line
         instead of sitting at the right edge. -->
    <div :class="compact ? 'flex items-center justify-between gap-1.5' : 'contents'">
    <div class="flex items-center min-w-0 flex-1" :class="compact ? 'gap-1.5' : 'gap-2'">
      <!-- Source platform: without it two same-named accounts on different
           platforms render identically (see the note on `platformMeta`). -->
      <span
        class="inline-flex items-center gap-1 shrink-0 text-slate-500 dark:text-slate-400"
        :class="compact ? 'text-[10px]' : 'text-[11px]'"
        :title="`来源平台：${platformName}`"
      >
        <span
          class="w-1.5 h-1.5 rounded-full shrink-0"
          :style="{ backgroundColor: platformMeta?.color || '#94a3b8' }"
        ></span>
        <span class="truncate" :class="compact ? 'max-w-[60px]' : 'max-w-[90px]'">{{ platformName }}</span>
      </span>

      <!-- Role Badge with Quick Cycle -->
      <button
        @click="emit('cycle-role', channel)"
        :title="compact ? '切换账号类型' : '切换账号类型：主账号 / 小号 / 里号 / 自定义'"
        class="rounded text-[10px] font-medium border cursor-pointer shrink-0 transition-colors"
        :class="[
          compact ? 'px-1 py-0.2' : 'px-1.5 py-0.5',
          ACCOUNT_ROLE_BADGE_CLASS[channel.accountRole || 'main'],
        ]"
      >
        {{ channel.label || ACCOUNT_ROLE_LABELS[channel.accountRole || 'main'] }}
      </button>
      <div
        v-if="!compact"
        class="w-5 h-5 rounded-full overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] text-slate-500"
      >
        <img
          v-if="channel.avatarUrl && !failedAvatarUrls?.has(channel.avatarUrl)"
          :src="channel.avatarUrl"
          referrerpolicy="no-referrer"
          class="w-full h-full object-cover"
          @error="emit('avatar-error', channel.avatarUrl)"
        />
        <span v-else>{{ (channel.displayName || channel.accountId || 'U').slice(0, 1) }}</span>
      </div>

      <a
        :href="channel.profileUrl"
        target="_blank"
        class="font-medium text-slate-700 dark:text-slate-200 hover:underline truncate"
        :class="compact ? 'text-[11px] max-w-[110px]' : 'flex items-center gap-1 max-w-[150px] sm:max-w-[200px]'"
        :title="channel.profileUrl"
      >
        <template v-if="!compact">
          <span class="truncate">{{ channel.displayName || channel.accountId }}</span>
          <ExternalLink class="w-2.5 h-2.5 text-slate-400 shrink-0" />
        </template>
        <template v-else>{{ channel.displayName || channel.accountId }}</template>
      </a>

      <!-- @accountId suffix (detailed view only) -->
      <span
        v-if="!compact && channel.displayName && channel.accountId && channel.displayName !== channel.accountId"
        class="text-[11px] text-slate-400 dark:text-slate-500 truncate hidden sm:inline shrink-0 max-w-[130px]"
        :title="'账号 ID: ' + channel.accountId"
      >
        {{ channel.accountId.startsWith('@') ? channel.accountId : '@' + channel.accountId }}
      </span>

      <!-- Sync status (detailed view only) -->
      <span
        v-if="!compact && channel.status === 'error'"
        class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-100 cursor-pointer shrink-0"
        title="查看同步错误详情"
        @click.stop="showSyncError"
      >
        同步失败
      </span>
      <span
        v-else-if="!compact && lastSyncAt"
        class="text-[10px] text-slate-400 dark:text-slate-500 hidden sm:inline-flex items-center gap-1 shrink-0 ml-auto mr-1"
        :title="'上次同步：' + new Date(lastSyncAt).toLocaleString('zh-CN')"
      >
        <span class="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></span>
        <span>{{ relativeTime(lastSyncAt) }}</span>
      </span>
    </div>

    <div class="flex items-center gap-0.5 shrink-0" :class="{ 'ml-2': !compact }">
      <button
        @click="emit('deep-sync', { creatorId, channelId: channel.id })"
        :title="compact ? '回溯该账号更早的历史动态' : '回溯该账号更早的历史动态'"
        class="p-1 text-slate-400 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded cursor-pointer"
        :class="!compact && 'rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors'"
      >
        <History :class="compact ? 'w-3 h-3' : 'w-3.5 h-3.5'" />
      </button>
      <button
        @click.exact="emit('refresh', { channel, force: false })"
        @click.shift.stop="emit('refresh', { channel, force: true })"
        :title="compact ? '同步最新动态（按住 Shift 强制覆盖）' : '同步最新动态（按住 Shift 可强制覆盖已有内容与图片）'"
        class="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
        :class="!compact && 'rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors'"
      >
        <RefreshCw :class="[compact ? 'w-3 h-3' : 'w-3.5 h-3.5', { 'animate-spin': isSyncing }]" />
      </button>
      <button
        @click="emit('delete', channel.id)"
        title="移除账号"
        class="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
        :class="!compact && 'rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors'"
      >
        <Trash2 :class="compact ? 'w-3 h-3' : 'w-3.5 h-3.5'" />
      </button>
      </div>
    </div>

    <!-- Error alert (compact mode: stacked under the row) -->
    <div
      v-if="compact && channel.errorMessage"
      class="mt-1 text-[9px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 p-1 rounded border border-rose-200/60 dark:border-rose-900/40 flex items-start gap-1"
    >
      <AlertCircle class="w-2.5 h-2.5 shrink-0 mt-0.5" />
      <span class="break-all">{{ channel.errorMessage }}</span>
    </div>
  </div>
</template>
