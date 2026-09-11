<script lang="ts">
import type { CreatorCardViewContext } from '../../types/creatorDirectory';

/**
 * 网格磁贴视图。契约即 `CreatorCardViewContext`（网格与详细卡片共用，见
 * `types/creatorDirectory.ts`）—— 不另起别名，两套卡片视图用同一个名字。
 *
 * 与工具条、紧凑列表同一条规则：**本组件不持有状态**。分列（`context.columns`）、
 * 排序、展开、勾选与拖拽状态都由 `CreatorsView` 持有，这里只渲染。
 */
</script>

<script setup lang="ts">
import { computed } from 'vue';
import { Plus, AlertCircle, ChevronDown } from 'lucide-vue-next';
import ChannelRow from './ChannelRow.vue';
import CreatorCardHeader from './CreatorCardHeader.vue';
import PlatformBadge from './PlatformBadge.vue';

const props = defineProps<{ context: CreatorCardViewContext }>();

// 与视图一致的浅只读包装：模板里统一写 `context.xxx`。
const context = computed(() => props.context);
</script>

<template>
  <!-- Grid Tiles View (8-16 creators per screen: compact cards with platform
     pills and a collapsible account list). -->
  <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5 items-start">
    <div
      v-for="(colCreators, colIdx) in context.columns"
      :key="'grid-col-' + colIdx"
      class="flex flex-col gap-3.5 min-w-0"
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
        class="p-3 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-2xs space-y-2.5 relative flex flex-col"
        :class="[
          context.selectedIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-xs',
          context.dragOverId === c.id ? 'ring-2 ring-indigo-400 border-dashed' : '',
        ]"
      >
      <div>
        <!-- Header Row: Checkbox / Avatar / Name / Actions -->
        <CreatorCardHeader
          :creator="c"
          variant="grid"
          :post-count="context.postCountMap[c.id] || 0"
          :avatar-url="context.creatorAvatar(c)"
          :is-batch-mode="context.isBatchMode"
          :is-selected="context.selectedIds.has(c.id)"
          :is-updating="context.syncSummary(c.id).isUpdating"
          :last-check-at="context.syncSummary(c.id).lastCheckAt"
          @toggle-select="context.onToggleSelect"
          @avatar-picker="context.onAvatarPicker"
          @avatar-error="context.onAvatarError"
          @refresh="context.onRefreshCreator"
          @deep-sync="context.onDeepSync"
          @edit-tags="context.onEditTags"
          @delete="context.onDeleteCreator"
        />
        <!-- Tags Preview (Compact) -->
        <div v-if="c.tags?.length" class="flex flex-wrap items-center gap-1 mt-1.5">
          <span
            v-for="t in c.tags.slice(0, 3)"
            :key="t"
            class="px-1.5 py-0.2 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
            @click="context.onCycleTag(t)"
            :title="'点击过滤标签 #' + t"
          >
            #{{ t }}
          </span>
          <span v-if="c.tags.length > 3" class="text-[10px] text-slate-400 font-mono">+{{ c.tags.length - 3 }}</span>
        </div>

        <!-- Attached Platform Badges & Health Indicator -->
        <div class="flex items-center justify-between gap-1.5 pt-2 mt-2 border-t border-slate-100 dark:border-slate-800">
          <!-- Platform Pills Row -->
          <div class="flex items-center gap-1 flex-wrap min-w-0">
            <template v-for="(chs, platform) in context.groupedChannels(c.id)" :key="platform">
              <PlatformBadge :platform="platform as string" :count="chs.length" compact />
            </template>
            <span v-if="context.channels.filter(ch => ch.creatorId === c.id).length === 0" class="text-[10px] text-slate-400">
              未绑定账号
            </span>
          </div>

          <!-- Sync Error Badge or Collapsible Account Details Toggle -->
          <div class="flex items-center gap-1 shrink-0">
            <span
              v-if="context.syncSummary(c.id).hasError"
              @click.stop="context.onToggleExpand(c.id)"
              class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 cursor-pointer flex items-center gap-0.5"
              title="存在同步异常账号，点击展开查看"
            >
              <AlertCircle class="w-2.5 h-2.5" />
              <span>{{ context.syncSummary(c.id).errorCount }}个异常</span>
            </span>
            <button
              type="button"
              @click="context.onToggleExpand(c.id)"
              class="inline-flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-indigo-600 dark:text-slate-500 dark:hover:text-indigo-400 transition-colors cursor-pointer"
              :title="context.expandedIds.has(c.id) ? '收起账号列表' : '展开账号列表'"
            >
              <span>{{ context.channels.filter(ch => ch.creatorId === c.id).length }} 个账号</span>
              <ChevronDown class="w-3 h-3 transition-transform duration-200" :class="{ 'rotate-180': context.expandedIds.has(c.id) }" />
            </button>
          </div>
        </div>

      <!-- Expanded Account Details in Grid Mode -->
      <div
        v-if="context.expandedIds.has(c.id)"
        class="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2 animate-fade-in"
      >
        <div class="flex items-center justify-between text-[10px] text-slate-500 pb-1">
          <span class="font-semibold text-slate-700 dark:text-slate-300">绑定的账号列表</span>
          <button
            @click="context.onAddChannel(c)"
            class="text-indigo-600 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
          >
            <Plus class="w-2.5 h-2.5" />
            <span>添加账号</span>
          </button>
        </div>

        <div class="space-y-1.5 max-h-48 overflow-y-auto pr-0.5">
          <ChannelRow
            v-for="ch in context.channels.filter(ch => ch.creatorId === c.id)"
            :key="ch.id"
            :channel="ch"
            :creator-id="c.id"
            :is-syncing="ch.status === 'updating' || context.syncingChannelIds?.has(ch.id)"
            compact
            @deep-sync="() => context.onDeepSync(c, ch.id)"
            @refresh="payload => context.onRefreshChannel(payload.channel, payload.force)"
            @delete="context.onDeleteChannel"
            @cycle-role="context.onCycleRole"
          />
        </div>
      </div>
      </div>
    </div>
  </div>
  </div>
</template>
