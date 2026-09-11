<script lang="ts">
import type { Channel, Creator } from '../../../../src/types';
import type { CreatorSortKey } from '../../composables/useCreatorDirectoryFilters';
import type {
  CreatorDirectoryActions,
  CreatorSyncSummary,
} from '../../types/creatorDirectory';

/**
 * 紧凑列表视图的上下文契约（由 `CreatorsView` 构建并传入）。
 *
 * 沿用工具条那套形状：**本组件不持有状态**。展示值由视图传入、用户操作经回调
 * 上抛，因此筛选、排序、展开与批量选择都只有一份状态，三套视图不会各记一份。
 */
export interface CreatorListViewContext extends CreatorDirectoryActions {
  /** 已筛选并排序后的创作者（视图侧 `filteredCreatorsList` 的值）。 */
  creators: Creator[];
  /** 全部平台账号（行内平台徽章、展开区与同步状态都读它）。 */
  channels: Channel[];
  /** creatorId -> 作品数。 */
  postCountMap: Record<string, number>;
  /** 正在单账号同步中的账号 ID 集合。 */
  syncingChannelIds?: Set<string>;

  /** 批量模式与勾选集合。 */
  isBatchMode: boolean;
  selectedIds: Set<string>;
  /** 已展开账号列表的创作者 ID 集合。 */
  expandedIds: Set<string>;
  /** 手动排序模式下拖拽经过的创作者 ID。 */
  dragOverId: string | null;
  /** 当前排序键与方向（表头箭头与 `aria-sort` 都读它）。 */
  sortBy: CreatorSortKey;
  sortDir: 'asc' | 'desc';

  /** 表头排序状态查询与切换。 */
  isSortedBy: (key: CreatorSortKey) => boolean;
  ariaSortFor: (key: CreatorSortKey) => 'ascending' | 'descending' | 'none';
  onToggleSort: (key: CreatorSortKey) => void;
  /** 点击行内标签芯片（三态过滤）。 */
  onCycleTag: (tag: string) => void;

  /** 展开/收起某一行的账号列表；行内任意空白处点击也走它。 */
  onToggleExpand: (creatorId: string) => void;
  onRowClick: (event: MouseEvent, creatorId: string) => void;

  /** 手动排序拖拽。 */
  onDragStart: (creatorId: string) => void;
  onDragOver: (event: DragEvent, creatorId: string) => void;
  onDragLeave: (creatorId: string) => void;
  onDrop: (creatorId: string) => void;
  onDragEnd: () => void;

  /** 批量勾选。 */
  onSelectAll: () => void;
  onToggleSelect: (creatorId: string) => void;

  /** 展示辅助（与网格/详细视图共用同一份实现）。 */
  groupedChannels: (creatorId: string) => Record<string, Channel[]>;
  syncSummary: (creatorId: string) => CreatorSyncSummary;
  relativeTime: (timestamp?: number) => string;
  creatorAvatar: (creator?: Creator | null) => string;
  onAvatarError: (url?: string) => void;
}
</script>

<script setup lang="ts">
import {
  RefreshCw,
  CheckSquare,
  Square,
  Plus,
  Edit3,
  History,
  Trash2,
  AlertCircle,
  ChevronDown,
  ChevronsUpDown,
} from 'lucide-vue-next';
import ChannelRow from './ChannelRow.vue';
// This import and the `Trash2` icon above were once used in the template without
// being imported, so they resolved to nothing and every 已绑平台账号 cell silently
// rendered EMPTY in all three views, as did the delete icon. `vue-tsc` does not
// flag an unresolved component unless `vueCompilerOptions.strictTemplates` is on
// (it is now — 2026-09-11), which is how that shipped unnoticed through four
// commits.
import PlatformBadge from './PlatformBadge.vue';
import { computed } from 'vue';

const props = defineProps<{ context: CreatorListViewContext }>();

// 与视图一致的浅只读包装：模板里统一写 `context.xxx`。
const context = computed(() => props.context);
</script>

<template>
  <!-- Compact Table List View (15-25+ Creators per screen, highest density) -->
  <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs overflow-hidden">
    <div class="overflow-x-auto">
      <!-- `table-fixed` + a width on EVERY column, and the percentages must keep
           summing to 100%.
           Reported 2026-09-11: the row had a ~500px blank hole between the platform
           badges and the tags. Cause: under the default auto layout, `w-full` hands
           all leftover width to whichever column declares none — that was
           已绑平台账号 — and its badges are left-aligned inside it, so the slack
           read as a hole in the middle of the row rather than as padding.
           Auto layout also re-derives that split from content, so it could not be
           fixed by sizing one column. With `table-fixed`, declared widths are
           honoured exactly and the slack is allocated by design; every cell already
           truncates or wraps (name truncates, badges and tags wrap), so nothing
           overflows. `tests/creatorsTable.test.ts` asserts the sum, because a
           missing width here is what reintroduces the hole.

           The percentages are derived from measured content, not picked by eye.
           At a 1471px table the columns need roughly: 创作者 175, 已绑平台账号 240
           (the widest row is four badges), 标签 165, 作品数 97, 同步状态 80, 操作 200
           — about 1000px in total, so ~470px has to live somewhere. The failure
           mode to avoid is one column absorbing all of it, which is what made one
           row read as 「a 500px hole between the badges and the tags」. These
           values keep the badge column at its content width (so the tags sit
           directly after the badges — the gap the user circled) and spread the rest
           so no column exceeds about 1.8x its content.

           One measured subtlety: slacks in ADJACENT columns read as a single gap,
           because the left cell's content sits at its column's start and the right
           cell's at its end. 同步状态 and 操作 are left- and right-aligned
           respectively, so an over-wide pair of them produced a 265px gap that the
           first attempt at this fix created. Both are kept tight for that reason.
           If a platform gains a much longer name, re-measure rather than guess. -->
      <table class="w-full table-fixed text-left border-collapse text-xs">
        <thead>
          <tr class="border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
            <th v-if="context.isBatchMode" class="py-2.5 px-3 w-10 text-center">
              <button @click="context.onSelectAll()" class="cursor-pointer text-indigo-600">
                <CheckSquare class="w-3.5 h-3.5" />
              </button>
            </th>
            <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-[24%]" :aria-sort="context.ariaSortFor('name')">
              <button
                type="button"
                class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                title="按创作者名称排序"
                @click="context.onToggleSort('name')"
              >
                <span>创作者</span>
                <ChevronDown v-if="context.isSortedBy('name')" class="w-3 h-3 shrink-0" :class="context.sortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
              </button>
            </th>
            <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-[17%]" :aria-sort="context.ariaSortFor('channels')">
              <button
                type="button"
                class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                title="按已绑定账号数量排序"
                @click="context.onToggleSort('channels')"
              >
                <span>已绑平台账号</span>
                <ChevronDown v-if="context.isSortedBy('channels')" class="w-3 h-3 shrink-0" :class="context.sortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
              </button>
            </th>
            <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-[18%]" :aria-sort="context.ariaSortFor('tags')">
              <button
                type="button"
                class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                title="按标签排序"
                @click="context.onToggleSort('tags')"
              >
                <span>标签</span>
                <ChevronDown v-if="context.isSortedBy('tags')" class="w-3 h-3 shrink-0" :class="context.sortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
              </button>
            </th>
            <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-[12%]" :aria-sort="context.ariaSortFor('posts')">
              <button
                type="button"
                class="sort-header w-full py-2.5 px-3 flex items-center justify-center gap-1 cursor-pointer"
                title="按作品数量排序"
                @click="context.onToggleSort('posts')"
              >
                <span>作品数</span>
                <ChevronDown v-if="context.isSortedBy('posts')" class="w-3 h-3 shrink-0" :class="context.sortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
              </button>
            </th>
            <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-[10%]" :aria-sort="context.ariaSortFor('updated')">
              <button
                type="button"
                class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                title="按最近同步时间排序"
                @click="context.onToggleSort('updated')"
              >
                <span>同步状态</span>
                <ChevronDown v-if="context.isSortedBy('updated')" class="w-3 h-3 shrink-0" :class="context.sortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
              </button>
            </th>
            <!-- Not sortable, so no button and no aria-sort: it holds row actions,
                 not data. -->
            <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-[19%] text-right">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
          <template v-for="c in context.creators" :key="'row-' + c.id">
            <tr
              :draggable="context.sortBy === 'manual'"
              @dragstart="context.onDragStart(c.id)"
              @dragover="(e: DragEvent) => context.onDragOver(e, c.id)"
              @dragleave="context.onDragLeave(c.id)"
              @drop="context.onDrop(c.id)"
              @dragend="context.onDragEnd()"
              @click="context.onRowClick($event, c.id)"
              class="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors group cursor-pointer"
              :class="[
                { 'bg-indigo-50/20 dark:bg-indigo-950/20': context.selectedIds.has(c.id) },
                context.dragOverId === c.id ? 'ring-2 ring-inset ring-indigo-400' : '',
              ]"
            >
              <!-- Batch Checkbox -->
              <td v-if="context.isBatchMode" class="py-2.5 px-3 text-center">
                <button @click.stop="context.onToggleSelect(c.id)" class="cursor-pointer text-indigo-600">
                  <CheckSquare v-if="context.selectedIds.has(c.id)" class="w-4 h-4 text-indigo-600" />
                  <Square v-else class="w-4 h-4 text-slate-400" />
                </button>
              </td>

              <!-- Creator: expander, avatar, name.
                   The expander is a leading chevron because that is where the
                   pattern puts a row-level disclosure control — first thing in
                   a left-to-right scan, and its x stays put regardless of how
                   many platform badges the row has. It previously sat after the
                   badges, which made its position depend on that row's content. -->
              <td class="py-2.5 px-3">
                <div class="flex items-center gap-2 min-w-0">
                  <!-- `.stop` is required: the row itself toggles on click, so
                       without it this button and the row would each toggle once
                       and cancel out. -->
                  <button
                    type="button"
                    class="shrink-0 p-0.5 -ml-0.5 rounded text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                    :aria-expanded="context.expandedIds.has(c.id)"
                    :title="context.expandedIds.has(c.id) ? '收起已绑定账号' : '展开已绑定账号'"
                    @click.stop="context.onToggleExpand(c.id)"
                  >
                    <ChevronDown
                      class="w-3.5 h-3.5 transition-transform duration-200"
                      :class="{ 'rotate-180': context.expandedIds.has(c.id) }"
                      aria-hidden="true"
                    />
                  </button>

                  <div
                    class="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 cursor-pointer shadow-2xs"
                    @click.stop="context.onAvatarPicker(c)"
                    title="更换主头像"
                  >
                    <img
                      v-if="context.creatorAvatar(c)"
                      :src="context.creatorAvatar(c)"
                      referrerpolicy="no-referrer"
                      @error="context.onAvatarError(context.creatorAvatar(c))"
                      class="w-full h-full object-cover"
                    />
                    <span v-else class="w-full h-full flex items-center justify-center font-bold text-indigo-600 text-xs">
                      {{ c.name.slice(0, 1) }}
                    </span>
                  </div>

                  <span class="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate max-w-[150px] sm:max-w-[200px]">{{ c.name }}</span>
                </div>
              </td>

              <!-- Attached Platform Badges (before 标签: these are what identify
                   the creator across sites, and they read better against the
                   name than the free-form tags do) -->
              <td class="py-2.5 px-3">
                <div class="flex items-center gap-1.5 flex-wrap min-w-0">
                  <template v-for="(chs, platform) in context.groupedChannels(c.id)" :key="platform">
                    <PlatformBadge :platform="platform as string" :count="chs.length" />
                  </template>
                  <span v-if="!Object.keys(context.groupedChannels(c.id)).length" class="text-[11px] text-slate-300 dark:text-slate-600">无账号</span>
                </div>
              </td>

              <!-- Tags -->
              <td class="py-2.5 px-3">
                <div class="flex items-center gap-1 flex-wrap">
                  <span
                    v-for="t in c.tags"
                    :key="t"
                    class="px-1.5 py-0.5 rounded text-[10px] font-normal bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-700/50"
                    @click.stop="context.onCycleTag(t)"
                    :title="'按此标签筛选：#' + t"
                  >
                    #{{ t }}
                  </span>
                  <span v-if="!c.tags?.length" class="text-[11px] text-slate-300 dark:text-slate-600">未分类</span>
                </div>
              </td>

              <!-- Post Count -->
              <td class="py-2.5 px-3 text-center text-slate-600 dark:text-slate-400">
                <span class="font-semibold text-slate-700 dark:text-slate-200">{{ context.postCountMap[c.id] || 0 }}</span>
                <span class="text-[10px] text-slate-400 ml-0.5">篇</span>
              </td>

              <!-- Sync Health & Last Checked -->
              <td class="py-2.5 px-3">
                <div class="flex items-center gap-1.5">
                  <span
                    v-if="context.syncSummary(c.id).isUpdating"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 border border-amber-200/60 dark:border-amber-900/40"
                  >
                    <RefreshCw class="w-2.5 h-2.5 animate-spin" />
                    <span>同步中</span>
                  </span>
                  <span
                    v-else-if="context.syncSummary(c.id).hasError"
                    class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400 border border-rose-200/60 dark:border-rose-900/40 cursor-pointer hover:bg-rose-100 transition-colors"
                    @click.stop="context.onToggleExpand(c.id)"
                    :title="context.syncSummary(c.id).firstErrorChannel?.errorMessage"
                  >
                    <AlertCircle class="w-2.5 h-2.5" />
                    <span>异常 ({{ context.syncSummary(c.id).errorCount }})</span>
                  </span>
                  <span
                    v-else
                    class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400"
                  >
                    <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                    <span>{{ context.relativeTime(context.syncSummary(c.id).lastCheckAt) }}</span>
                  </span>
                </div>
              </td>

              <!-- Action Toolbar -->
              <td class="py-2.5 px-3 text-right">
                <div class="flex items-center justify-end gap-1">
                  <button
                    @click.stop="context.onRefreshCreator(c.id)"
                    title="同步最新动态"
                    class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': context.syncSummary(c.id).isUpdating }" />
                  </button>
                  <button
                    @click.stop="context.onDeepSync(c)"
                    title="回溯该创作者更早的历史动态"
                    class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <History class="w-3.5 h-3.5" />
                  </button>
                  <button
                    @click.stop="context.onAddChannel(c)"
                    title="绑定新账号"
                    class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Plus class="w-3.5 h-3.5" />
                  </button>
                  <button
                    @click.stop="context.onEditTags(c)"
                    title="编辑标签"
                    class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                  >
                    <Edit3 class="w-3.5 h-3.5" />
                  </button>
                  <button
                    @click.stop="context.onDeleteCreator(c.id)"
                    title="移除创作者"
                    class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 class="w-3.5 h-3.5" />
                  </button>
                </div>
              </td>
            </tr>

            <!-- Nested Table Row if Expanded -->
            <tr v-if="context.expandedIds.has(c.id)" class="bg-slate-50/50 dark:bg-slate-800/40">
              <td :colspan="context.isBatchMode ? 7 : 6" class="p-3">
                <div class="rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
                  <div class="flex items-center justify-between text-xs pb-1 border-b border-slate-100 dark:border-slate-800">
                    <span class="font-bold text-slate-700 dark:text-slate-200">【{{ c.name }}】全部已绑定平台账号</span>
                    <button
                      @click="context.onAddChannel(c)"
                      class="text-xs text-indigo-600 dark:text-indigo-400 font-semibold hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      <Plus class="w-3 h-3" />
                      <span>绑定新平台账号</span>
                    </button>
                  </div>

                  <div class="grid grid-cols-1 md:grid-cols-2 gap-2">
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
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>
</template>
