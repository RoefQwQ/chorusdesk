<script lang="ts">
import type { CreatorCardViewContext } from '../../types/creatorDirectory';

/**
 * 详细卡片视图（完整展开式手风琴：头像/名称/统计 + 标签 + 按平台分组的账号区）。
 *
 * 契约用共用类型 `CreatorCardViewContext` 再补一项本视图专属的 `failedAvatarUrls`
 * —— 账号行要靠它回退到首字母。与其余两套视图同一条规则：**不持有状态**，
 * 值与动作全部由 `CreatorsView` 的 `detailedContext` 提供。
 */
export interface CreatorDetailedViewContext extends CreatorCardViewContext {
  /** 加载失败的头像 URL 集合（交给 `ChannelRow` 决定是否回退首字母）。 */
  failedAvatarUrls: Set<string>;
}
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { Plus, Edit3, AlertCircle } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, type Platform } from '../../../../src/types';
import ChannelRow from './ChannelRow.vue';
import CreatorCardHeader from './CreatorCardHeader.vue';

const props = defineProps<{ context: CreatorDetailedViewContext }>();

// 与视图一致的浅只读包装：模板里统一写 `context.xxx`。
const context = computed(() => props.context);
</script>

<template>
  <!-- Detailed Cards View (the complete accordion layout). -->
  <div class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 xl:gap-5 items-start">
    <div
      v-for="(colCreators, colIdx) in context.columns"
      :key="'detail-col-' + colIdx"
      class="flex flex-col gap-4 xl:gap-5 min-w-0"
    >
      <div
        v-for="c in colCreators"
        :key="c.id"
        :draggable="context.sortBy === 'manual'"
        @dragstart="context.onDragStart(c.id)"
        @dragover="(e: DragEvent) => context.onDragOver(e, c.id)"
        @dragleave="context.onDragLeave(c.id)"
        @drop="context.onDrop(c.id)"
        @dragend="context.onDragEnd()"
        class="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-sm space-y-3 relative overflow-hidden"
        :class="[
          context.selectedIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md',
          context.dragOverId === c.id ? 'ring-2 ring-indigo-400 border-dashed' : '',
        ]"
      >
      <!-- Top Row: Avatar, Name, Stats & Actions -->
      <CreatorCardHeader
        :creator="c"
        variant="detailed"
        :post-count="context.postCountMap[c.id] || 0"
        :avatar-url="context.creatorAvatar(c)"
        :is-batch-mode="context.isBatchMode"
        :is-selected="context.selectedIds.has(c.id)"
        :is-updating="context.syncSummary(c.id).isUpdating"
        @toggle-select="context.onToggleSelect"
        @avatar-picker="context.onAvatarPicker"
        @avatar-error="context.onAvatarError"
        @refresh="context.onRefreshCreator"
        @deep-sync="context.onDeepSync"
        @edit-tags="context.onEditTags"
        @delete="context.onDeleteCreator"
      />

      <!-- Inline tag chips (detailed variant) -->
      <div class="flex flex-wrap items-center gap-1 mt-1">
        <span
          v-for="t in c.tags"
          :key="t"
          class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
          @click="context.onCycleTag(t)"
          :title="'按此标签筛选：#' + t"
        >
          #{{ t }}
        </span>
        <span v-if="!c.tags?.length" class="text-[10px] text-slate-400">未分类</span>
        <button
          type="button"
          @click.stop="context.onEditTags(c)"
          title="编辑修改创作者标签"
          class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] text-indigo-600 dark:text-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/60 cursor-pointer transition-colors"
        >
          <Edit3 class="w-3 h-3" />
          <span>编辑标签</span>
        </button>
      </div>

      <!-- Attached Channels Grouped by Platform -->
      <div class="space-y-2.5 pt-2 border-t border-slate-100 dark:border-slate-800">
        <div class="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 pb-1">
          <span class="font-semibold text-slate-700 dark:text-slate-300">已绑定账号</span>
          <button @click="context.onAddChannel(c)" class="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold flex items-center gap-1 cursor-pointer bg-indigo-50 dark:bg-indigo-950/60 px-2 py-1 rounded-lg border border-indigo-100 dark:border-indigo-900 transition-colors">
            <Plus class="w-3 h-3" />
            <span>+ 绑定新账号</span>
          </button>
        </div>

        <!-- Grouped Platform Sections -->
        <div class="space-y-2">
          <div
            v-for="(chs, platform) in context.groupedChannels(c.id)"
            :key="platform"
            class="rounded-xl border border-slate-200/70 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-800/60 p-2.5 space-y-1.5"
          >
            <!-- Platform Header within Creator -->
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5">
                <span :class="PLATFORM_REGISTRY[platform as Platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'" class="px-2 py-0.5 rounded text-[10px] font-bold border">
                  {{ PLATFORM_REGISTRY[platform as Platform]?.name || platform }}
                </span>
                <span class="text-[11px] text-slate-400">
                  {{ chs.length > 1 ? `绑定了 ${chs.length} 个账号（同平台多账号互通）` : '1 个账号' }}
                </span>
              </div>
            </div>

            <!-- Account Rows within this Platform -->
            <div class="space-y-1">
              <ChannelRow
                v-for="ch in chs"
                :key="ch.id"
                :channel="ch"
                :creator-id="c.id"
                :is-syncing="ch.status === 'updating' || context.syncingChannelIds?.has(ch.id)"
                :failed-avatar-urls="context.failedAvatarUrls"
                @deep-sync="() => context.onDeepSync(c, ch.id)"
                @refresh="payload => context.onRefreshChannel(payload.channel, payload.force)"
                @delete="context.onDeleteChannel"
                @cycle-role="context.onCycleRole"
                @avatar-error="context.onAvatarError"
              />

              <div
                v-for="ch in chs.filter(c => c.errorMessage)"
                :key="'err-' + ch.id"
                class="text-[10px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/50 p-1.5 rounded-md border border-rose-200 dark:border-rose-900/60 flex items-start gap-1"
              >
                <AlertCircle class="w-3 h-3 shrink-0 mt-0.5 text-rose-500" />
                <span class="break-all">{{ ch.displayName || ch.accountId }}: {{ ch.errorMessage }}</span>
              </div>
            </div>
          </div>

          <div v-if="context.channels.filter(ch => ch.creatorId === c.id).length === 0" class="text-center py-4 text-xs text-slate-400">
            暂无绑定账号，点击上方 + 绑定新账号
          </div>
        </div>
      </div>
    </div>
  </div>
  </div>
</template>
