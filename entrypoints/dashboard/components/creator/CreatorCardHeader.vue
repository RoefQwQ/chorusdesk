<script setup lang="ts">
import { CheckSquare, Square, Camera, RefreshCw, History, Edit3, Trash2 } from 'lucide-vue-next';
import type { Creator } from '../../../../src/types';

/**
 * 创作者卡片头部：批量勾选、可更换头像、名称与作品计数、快捷操作按钮。
 * 网格视图与详细视图原先各内联一份（尺寸、按钮集、文案均略有出入），
 * 此组件以 variant 收敛。
 *
 * - `grid`：紧凑头部（w-10 头像 / 4 个图标按钮 / “N 篇作品 · 相对时间”行）；
 * - `detailed`：大号头部（w-11 头像 / 标签内联 + “回溯历史”文字按钮）。
 */
defineProps<{
  creator: Creator;
  /** 展示变体：grid（网格卡片）| detailed（详细卡片）。 */
  variant: 'grid' | 'detailed';
  /** 该创作者的作品数。 */
  postCount: number;
  /** 安全化后的头像 URL（空串表示回退首字）。 */
  avatarUrl: string;
  /** 是否处于批量选择模式。 */
  isBatchMode: boolean;
  /** 是否已被批量选中。 */
  isSelected: boolean;
  /** 该创作者是否正在同步。 */
  isUpdating: boolean;
  /** 全部渠道最近一次检查时间（聚合自 channel.lastCheckAt）。 */
  lastCheckAt?: number;
}>();

const emit = defineEmits<{
  (e: 'toggle-select', creatorId: string): void;
  (e: 'avatar-picker', creator: Creator): void;
  (e: 'avatar-error', url?: string): void;
  (e: 'refresh', creatorId: string): void;
  (e: 'deep-sync', creator: Creator): void;
  (e: 'edit-tags', creator: Creator): void;
  (e: 'delete', creatorId: string): void;
  (e: 'cycle-tag-filter', tag: string): void;
}>();

/** 相对时间（与 CreatorsView.formatRelativeTime 同语义）。 */
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
</script>

<template>
  <div class="flex items-start justify-between" :class="variant === 'grid' ? 'gap-2' : 'gap-3'">
    <div class="flex items-center min-w-0" :class="variant === 'grid' ? 'gap-2.5' : 'gap-3'">
      <!-- Batch Checkbox -->
      <button
        v-if="isBatchMode"
        @click="emit('toggle-select', creator.id)"
        class="shrink-0 text-indigo-600 hover:scale-105 transition-transform cursor-pointer"
      >
        <CheckSquare v-if="isSelected" :class="variant === 'grid' ? 'w-4 h-4' : 'w-5 h-5'" class="text-indigo-600" />
        <Square v-else :class="variant === 'grid' ? 'w-4 h-4' : 'w-5 h-5'" class="text-slate-400" />
      </button>

      <!-- Avatar with Change Overlay -->
      <div
        class="relative group/avatar rounded-xl bg-gradient-to-br from-indigo-50 to-violet-100 dark:from-indigo-950/70 dark:to-violet-900/50 flex items-center justify-center text-indigo-600 font-black overflow-hidden border border-indigo-100 dark:border-indigo-900 shrink-0 shadow-inner cursor-pointer"
        :class="variant === 'grid' ? 'w-10 h-10 text-sm' : 'w-11 h-11 text-lg'"
        @click.stop="emit('avatar-picker', creator)"
        title="更换主头像"
      >
        <img
          v-if="avatarUrl"
          :src="avatarUrl"
          referrerpolicy="no-referrer"
          @error="emit('avatar-error', avatarUrl)"
          class="w-full h-full object-cover transition-transform duration-200 group-hover/avatar:scale-105"
        />
        <span v-else>{{ creator.name.slice(0, 1) }}</span>
        <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center text-white">
          <Camera :class="variant === 'grid' ? 'w-3.5 h-3.5' : 'w-4 h-4'" class="drop-shadow" />
        </div>
      </div>

      <!-- Name & Post Count / Tags -->
      <div class="min-w-0">
        <div class="flex items-center gap-1.5">
          <h3 class="font-bold text-slate-900 dark:text-white truncate" :class="variant === 'grid' ? 'text-sm' : 'text-base'" :title="creator.name">{{ creator.name }}</h3>
        </div>
        <div v-if="variant === 'grid'" class="flex items-center gap-1.5 text-[11px] text-slate-400">
          <span class="font-medium text-slate-600 dark:text-slate-300">{{ postCount }} 篇作品</span>
          <span>•</span>
          <span :title="'上次检查：' + (lastCheckAt ? new Date(lastCheckAt).toLocaleString('zh-CN') : '尚未检查')">
            {{ relativeTime(lastCheckAt) }}
          </span>
        </div>
      </div>
    </div>

    <!-- Action Buttons -->
    <div class="flex items-center shrink-0" :class="variant === 'grid' ? 'gap-0.5' : 'gap-1'">
      <template v-if="variant === 'grid'">
        <button
          @click="emit('refresh', creator.id)"
          :title="isUpdating ? '正在同步中…' : '同步该创作者所有账号'"
          class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
        >
          <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': isUpdating }" />
        </button>
        <button
          @click="emit('deep-sync', creator)"
          title="回溯该创作者更早的历史动态"
          class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
        >
          <History class="w-3.5 h-3.5" />
        </button>
        <button
          @click="emit('edit-tags', creator)"
          title="编辑创作者标签"
          class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
        >
          <Edit3 class="w-3.5 h-3.5" />
        </button>
        <button
          @click="emit('delete', creator.id)"
          title="移除创作者"
          class="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
        >
          <Trash2 class="w-3.5 h-3.5" />
        </button>
      </template>
      <template v-else>
        <button
          @click="emit('deep-sync', creator)"
          title="回溯该创作者更早的历史动态"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 text-xs font-semibold transition-colors cursor-pointer border border-indigo-200/60 dark:border-indigo-800/60 shadow-2xs"
        >
          <History class="w-3.5 h-3.5" />
          <span class="hidden sm:inline">回溯历史</span>
        </button>
        <button
          @click="emit('refresh', creator.id)"
          :title="isUpdating ? '正在同步中…' : '同步最新动态'"
          class="p-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
        >
          <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': isUpdating }" />
        </button>
        <button
          @click="emit('delete', creator.id)"
          title="移除该创作者档案"
          class="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/60 rounded-xl transition-colors cursor-pointer"
        >
          <Trash2 class="w-4 h-4" />
        </button>
      </template>
    </div>
  </div>
</template>
