<script lang="ts">
/**
 * CreatorsView 上下文契约（由上层组合层构建并传入）。
 *
 * 只承载展示数据与派生计数；凡涉及数据库/同步/弹窗副作用的行为一律通过 emits 上抛，
 * 本组件不导入 Dexie、adapter 或 background 消息通道（见 docs/DASHBOARD_MIGRATION.md 的 View 约束）。
 */
export interface CreatorsViewContext {
  /** 已关注的创作者档案列表 */
  creators: Creator[];
  /** 全部平台账号（按 creatorId 归属各创作者） */
  channels: Channel[];
  /** creatorId -> 作品数（卡片统计与「作品数」排序） */
  creatorPostCountMap: Record<string, number>;
  /** platform key -> 绑定了该平台的创作者数量（平台筛选胶囊角标） */
  creatorCountByPlatform: Record<string, number>;
  /** 侧栏平台自定义顺序（platform 排序模式与手动排序展示用）。 */
  platformOrder: string[];
  /** 正在执行单人同步中的创作者 ID 集合 */
  syncingCreatorIds?: Set<string>;
  /** 正在执行单账号同步中的账号 ID 集合 */
  syncingChannelIds?: Set<string>;
}
</script>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import {
  PLATFORM_REGISTRY,
  type AccountRole,
  type Platform,
  type Creator,
  type Channel,
} from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import {
  Plus,
  Search,
  Edit3,
  AlertCircle,
  Users,
} from 'lucide-vue-next';
import ChannelRow from '../components/creator/ChannelRow.vue';
import CreatorCardHeader from '../components/creator/CreatorCardHeader.vue';
import CreatorListView, {
  type CreatorListViewContext,
} from '../components/creator/CreatorListView.vue';
import CreatorGridView from '../components/creator/CreatorGridView.vue';
import type { CreatorCardViewContext, CreatorSyncSummary } from '../types/creatorDirectory';
import CreatorDirectoryToolbar, {
  type CreatorDirectoryToolbarContext,
} from '../components/creator/CreatorDirectoryToolbar.vue';
import {
  useCreatorDirectoryFilters,
  type CreatorSortKey,
} from '../composables/useCreatorDirectoryFilters';

const props = defineProps<{ context: CreatorsViewContext }>();

/**
 * props 本身是浅只读的，通过 computed 包装后在模板中以 `context.xxx` 访问。
 * 上层应传入新对象字面量（或保证对象引用随数据变化而更新），以驱动本组件重渲染。
 */
const context = computed(() => props.context);

const emit = defineEmits<{
  (e: 'add', payload: { mode: 'new' | 'channel'; creator?: Creator }): void;
  (e: 'avatar-picker', creator: Creator): void;
  (e: 'deep-sync', payload: { creator: Creator; channelId?: string }): void;
  (e: 'edit-tags', creator: Creator): void;
  (e: 'refresh-creator', creatorId: string): void;
  (e: 'refresh-channel', payload: { channel: Channel; force: boolean }): void;
  (e: 'delete-creator', creatorId: string): void;
  (e: 'delete-channel', channelId: string): void;
  (e: 'cycle-channel-role', channel: Channel): void;
  (e: 'batch-refresh', creatorIds: string[]): void;
  (e: 'batch-delete', creatorIds: string[]): void;
  (e: 'reorder-creators', orderedIds: string[]): void;
  (e: 'demo-data'): void;
}>();

// ==================== MANUAL DRAG SORT (manual sort mode only) ====================
const dragCreatorId = ref<string | null>(null);
const dragOverCreatorId = ref<string | null>(null);

function onCreatorDragStart(id: string) {
  if (creatorSortBy.value !== 'manual') return;
  dragCreatorId.value = id;
}

function onCreatorDragOver(e: DragEvent, id: string) {
  if (creatorSortBy.value !== 'manual' || dragCreatorId.value === null || dragCreatorId.value === id) return;
  e.preventDefault();
  dragOverCreatorId.value = id;
}

function onCreatorDrop(id: string) {
  const from = dragCreatorId.value;
  if (creatorSortBy.value !== 'manual' || from === null || from === id) {
    dragCreatorId.value = null;
    dragOverCreatorId.value = null;
    return;
  }
  const next = [...filteredCreatorsList.value.map(c => c.id)];
  const fromIdx = next.indexOf(from);
  const toIdx = next.indexOf(id);
  if (fromIdx !== -1 && toIdx !== -1) {
    next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
    emit('reorder-creators', next);
  }
  dragCreatorId.value = null;
  dragOverCreatorId.value = null;
}

// ==================== CREATORS DIRECTORY: FILTER / SORT / BATCH STATE ====================
// Search, filters, sorting and the derived list live in the composable; this view
// keeps only what it renders and owns (view mode, expansion, selection, avatars).
const directory = useCreatorDirectoryFilters({
  creators: () => props.context.creators,
  channels: () => props.context.channels,
  creatorPostCountMap: () => props.context.creatorPostCountMap,
  platformOrder: () => props.context.platformOrder,
});
const {
  creatorSearch,
  creatorPlatformFilter,
  creatorTagFilter,
  creatorRoleFilter,
  includeTags,
  excludeTags,
  creatorSortOptions,
  creatorSortBy,
  creatorSortDir,
  sortSelection,
  toggleSort,
  isSortedBy,
  ariaSortFor,
  allTags,
  cycleTagFilter,
  clearAllTagFilters,
  getTagFilterState,
  creatorCountByRole,
  filteredCreatorsList,
} = directory;

const VIEW_MODE_STORAGE_KEY = 'creator_feed_creators_view_mode';
const viewMode = ref<'grid' | 'list' | 'detailed'>(
  (typeof localStorage !== 'undefined' &&
    (localStorage.getItem(VIEW_MODE_STORAGE_KEY) as 'grid' | 'list' | 'detailed' | null)) ||
  'grid'
);

function setViewMode(mode: 'grid' | 'list' | 'detailed') {
  viewMode.value = mode;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // Storage write blocked: view mode stays in memory for this session.
  }
}

const isTagsExpanded = ref(false);
const expandedCreatorIds = ref<Set<string>>(new Set());

function toggleExpandCreator(id: string) {
  if (expandedCreatorIds.value.has(id)) {
    expandedCreatorIds.value.delete(id);
  } else {
    expandedCreatorIds.value.add(id);
  }
  expandedCreatorIds.value = new Set(expandedCreatorIds.value);
}

/**
 * Clicking anywhere on a row toggles its detail. Reported 2026-09-11: the
 * chevron was the only target, so the row looked inert.
 *
 * The chevron stays a real `<button>` with `aria-expanded`, which is what keeps
 * this keyboard- and screen-reader-accessible; widening the target for the mouse
 * is all this is. Every control inside the row calls `@click.stop`, so anything
 * that lands here is genuinely blank space.
 *
 * Two gestures that are *not* "open this row" have to be excluded, or they would
 * fire by accident on the way to something else:
 */
function onRowClick(event: MouseEvent, creatorId: string) {
  // 1. Selecting a name to copy it. A click on the last word of a drag-select
  //    would otherwise collapse or expand the row under the cursor.
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed) return;

  // 2. Finishing a manual drag-reorder. Chrome suppresses `click` after a real
  //    drag, but a drag that ends where it started does produce one.
  if (creatorSortBy.value === 'manual' && event.detail === 1 && dragCreatorId.value) return;

  toggleExpandCreator(creatorId);
}

/** 批量选择模式：开启后每行/卡片显示复选框，工具栏切换为批量操作。 */
const isBatchMode = ref(false);
const selectedCreatorIds = ref<Set<string>>(new Set());
const failedAvatarUrls = ref<Set<string>>(new Set());


// Avatar fallback & failure handling
function handleAvatarError(url?: string) {
  if (url) {
    failedAvatarUrls.value.add(url);
    failedAvatarUrls.value = new Set(failedAvatarUrls.value);
  }
}

/**
 * 主头像解析：档案头像 -> 首个带头像的绑定频道头像。
 * （原 App.vue 会顺带把发现到的头像写回数据库；写回属上层副作用，不在此处执行。）
 */
function getCreatorAvatar(c?: Creator | null): string {
  if (!c) return '';
  if (c.avatar && c.avatar.trim().length > 0 && !failedAvatarUrls.value.has(c.avatar)) {
    return toSecureMediaUrl(c.avatar);
  }
  const ch = context.value.channels.find(
    ch => ch.creatorId === c.id && ch.avatarUrl && ch.avatarUrl.trim().length > 0 && !failedAvatarUrls.value.has(ch.avatarUrl)
  );
  if (ch?.avatarUrl) {
    return toSecureMediaUrl(ch.avatarUrl);
  }
  return '';
}

// ==================== RESPONSIVE MASONRY COLUMN STACKS ====================
// Tracking windowWidth to distribute creators into independent columns,
// ensuring expanding a card in one column NEVER affects sibling columns.
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1280);
function handleResize() {
  windowWidth.value = window.innerWidth;
}
onMounted(() => {
  window.addEventListener('resize', handleResize);
});
onUnmounted(() => {
  window.removeEventListener('resize', handleResize);
});

// Grid mode column count (1 to 4 columns)
const gridColCount = computed(() => {
  if (windowWidth.value < 640) return 1;
  if (windowWidth.value < 1024) return 2;
  if (windowWidth.value < 1280) return 3;
  return 4;
});

const gridColumns = computed(() => {
  const count = gridColCount.value;
  const cols: Creator[][] = Array.from({ length: count }, () => []);
  filteredCreatorsList.value.forEach((c, idx) => {
    cols[idx % count].push(c);
  });
  return cols;
});

// Detailed mode column count (1 to 3 columns, avoiding oversized 1000px cards on 2xl)
const detailedColCount = computed(() => {
  if (windowWidth.value < 1024) return 1;
  if (windowWidth.value < 1536) return 2;
  return 3;
});

const detailedColumns = computed(() => {
  const count = detailedColCount.value;
  const cols: Creator[][] = Array.from({ length: count }, () => []);
  filteredCreatorsList.value.forEach((c, idx) => {
    cols[idx % count].push(c);
  });
  return cols;
});

function toggleSelectCreator(id: string) {
  if (selectedCreatorIds.value.has(id)) {
    selectedCreatorIds.value.delete(id);
  } else {
    selectedCreatorIds.value.add(id);
  }
  selectedCreatorIds.value = new Set(selectedCreatorIds.value);
}

function selectAllFilteredCreators() {
  const set = new Set<string>();
  filteredCreatorsList.value.forEach(c => set.add(c.id));
  selectedCreatorIds.value = set;
}

function clearCreatorSelection() {
  selectedCreatorIds.value = new Set();
}

function batchRefreshSelectedCreators() {
  const ids = Array.from(selectedCreatorIds.value);
  if (ids.length === 0) return;
  emit('batch-refresh', ids);
}

function batchDeleteSelectedCreators() {
  const ids = Array.from(selectedCreatorIds.value);
  if (ids.length === 0) return;
  emit('batch-delete', ids);
}

/**
 * Drag events that the row template used to handle inline.
 *
 * `dragleave` fires for every element the pointer crosses, so it must only clear
 * the highlight when the row being left is the one currently highlighted —
 * otherwise moving across a row's own cells clears it and the drop target flickers.
 */
function onDragLeave(creatorId: string) {
  if (dragOverCreatorId.value === creatorId) dragOverCreatorId.value = null;
}

function onDragEnd() {
  dragCreatorId.value = null;
  dragOverCreatorId.value = null;
}

/** Leaving batch mode drops the selection: the checkboxes are gone from the UI. */
function toggleBatchMode() {
  isBatchMode.value = !isBatchMode.value;
  if (!isBatchMode.value) selectedCreatorIds.value = new Set();
}

/**
 * The toolbar's contract: values down, callbacks up.
 *
 * A fresh object per render is intentional (and is what re-renders the toolbar):
 * the component holds no state of its own, so the filters cannot drift between
 * the toolbar and the three view templates that read the same composable.
 */
const toolbarContext = computed<CreatorDirectoryToolbarContext>(() => ({
  search: creatorSearch.value,
  platformFilter: creatorPlatformFilter.value,
  roleFilter: creatorRoleFilter.value,
  sortBy: creatorSortBy.value,
  sortOptions: creatorSortOptions,
  viewMode: viewMode.value,
  tagsExpanded: isTagsExpanded.value,
  isBatchMode: isBatchMode.value,
  selectedCount: selectedCreatorIds.value.size,
  allTags: allTags.value,
  includeTags: includeTags.value,
  excludeTags: excludeTags.value,
  creatorCountByPlatform: props.context.creatorCountByPlatform,
  creatorCountByRole: creatorCountByRole.value,
  filteredCount: filteredCreatorsList.value.length,
  totalCount: props.context.creators.length,
  onSearch: (value) => { creatorSearch.value = value; },
  onPlatform: (value) => { creatorPlatformFilter.value = value; },
  onRole: (value) => { creatorRoleFilter.value = value as 'all' | AccountRole; },
  onSort: (key) => { sortSelection.value = key as CreatorSortKey; },
  onViewMode: setViewMode,
  onToggleTagsExpanded: () => { isTagsExpanded.value = !isTagsExpanded.value; },
  onCycleTag: cycleTagFilter,
  onClearTagFilters: clearAllTagFilters,
  onToggleBatchMode: toggleBatchMode,
  onSelectAll: selectAllFilteredCreators,
  onClearSelection: clearCreatorSelection,
  onBatchRefresh: batchRefreshSelectedCreators,
  onBatchDelete: batchDeleteSelectedCreators,
  onAdd: () => openAddModal('new'),
  getTagFilterState,
}));

/**
 * The compact list view's contract.
 *
 * Same shape and same reason as `toolbarContext`: the child renders only, so the
 * sort, expansion, selection and drag state stay owned here and cannot drift
 * between the three view templates. The presentation helpers (`syncSummary`,
 * `relativeTime`, `groupedChannels`, `creatorAvatar`) are passed rather than
 * re-implemented, so there is exactly one definition of each.
 */
const listContext = computed<CreatorListViewContext>(() => ({
  creators: filteredCreatorsList.value,
  channels: props.context.channels,
  postCountMap: props.context.creatorPostCountMap,
  syncingChannelIds: props.context.syncingChannelIds,

  isBatchMode: isBatchMode.value,
  selectedIds: selectedCreatorIds.value,
  expandedIds: expandedCreatorIds.value,
  dragOverId: dragOverCreatorId.value,
  sortBy: creatorSortBy.value,
  sortDir: creatorSortDir.value,

  isSortedBy,
  ariaSortFor,
  onToggleSort: toggleSort,
  onCycleTag: cycleTagFilter,
  onToggleExpand: toggleExpandCreator,
  onRowClick,

  onDragStart: onCreatorDragStart,
  onDragOver: onCreatorDragOver,
  onDragLeave,
  onDrop: onCreatorDrop,
  onDragEnd,

  onSelectAll: selectAllFilteredCreators,
  onToggleSelect: toggleSelectCreator,

  groupedChannels: getCreatorGroupedChannels,
  syncSummary: getCreatorSyncSummary,
  relativeTime: formatRelativeTime,
  creatorAvatar: getCreatorAvatar,
  onAvatarError: handleAvatarError,

  onAddChannel: (creator) => openAddModal('channel', creator),
  onAvatarPicker: openAvatarPicker,
  onDeepSync: openDeepSyncModal,
  onEditTags: openEditCreatorTags,
  onRefreshCreator: handleRefreshCreator,
  onRefreshChannel: handleRefreshChannel,
  onDeleteCreator: deleteCreator,
  onDeleteChannel: deleteChannel,
  onCycleRole: cycleChannelRole,
}));

/**
 * The two card views' shared contract (grid and detailed both render masonry
 * columns of `CreatorCardHeader` cards).
 *
 * Built once and spread into each view's context so the two cannot drift: adding
 * a helper for one of them and forgetting the other is exactly the failure this
 * shape prevents.
 */
const cardViewContext = computed(() => ({
  channels: props.context.channels,
  postCountMap: props.context.creatorPostCountMap,
  syncingChannelIds: props.context.syncingChannelIds,

  isBatchMode: isBatchMode.value,
  selectedIds: selectedCreatorIds.value,
  expandedIds: expandedCreatorIds.value,
  dragOverId: dragOverCreatorId.value,
  sortBy: creatorSortBy.value,

  onToggleExpand: toggleExpandCreator,
  onDragStart: onCreatorDragStart,
  onDragOver: onCreatorDragOver,
  onDragLeave,
  onDrop: onCreatorDrop,
  onDragEnd,
  onToggleSelect: toggleSelectCreator,
  onCycleTag: cycleTagFilter,

  groupedChannels: getCreatorGroupedChannels,
  syncSummary: getCreatorSyncSummary,
  relativeTime: formatRelativeTime,
  creatorAvatar: getCreatorAvatar,
  onAvatarError: handleAvatarError,

  onAddChannel: (creator: Creator) => openAddModal('channel', creator),
  onAvatarPicker: openAvatarPicker,
  onDeepSync: openDeepSyncModal,
  onEditTags: openEditCreatorTags,
  onRefreshCreator: handleRefreshCreator,
  onRefreshChannel: handleRefreshChannel,
  onDeleteCreator: deleteCreator,
  onDeleteChannel: deleteChannel,
  onCycleRole: cycleChannelRole,
}));

const gridContext = computed<CreatorCardViewContext>(() => ({
  ...cardViewContext.value,
  columns: gridColumns.value,
}));

// Account role labels/badge classes live in ChannelRow (single source).

function getCreatorGroupedChannels(creatorId: string): Record<string, Channel[]> {
  const chs = context.value.channels.filter(ch => ch.creatorId === creatorId);
  const map: Record<string, Channel[]> = {};
  for (const ch of chs) {
    if (!map[ch.platform]) {
      map[ch.platform] = [];
    }
    map[ch.platform].push(ch);
  }
  return map;
}

/**
 * 聚合分析创作者旗下全部频道的同步健康状况。
 *
 * 返回类型显式标注为 `CreatorSyncSummary`：它同时被紧凑列表、网格与详细卡片消费，
 * 靠结构巧合一致是不够的——签名变了要在这里报错。
 */
function getCreatorSyncSummary(creatorId: string): CreatorSyncSummary {
  const chs = context.value.channels.filter(ch => ch.creatorId === creatorId);
  const total = chs.length;
  const errorChannels = chs.filter(ch => ch.status === 'error');
  const isUpdating = Boolean(
    context.value.syncingCreatorIds?.has(creatorId) ||
    chs.some(ch => ch.status === 'updating' || context.value.syncingChannelIds?.has(ch.id))
  );
  const lastCheckAt = Math.max(0, ...chs.map(ch => ch.lastCheckAt || 0));

  return {
    total,
    hasError: errorChannels.length > 0,
    errorCount: errorChannels.length,
    firstErrorChannel: errorChannels[0],
    isUpdating,
    lastCheckAt,
  };
}

function formatRelativeTime(timestamp?: number): string {
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

// ==================== SIDE-EFFECT ACTIONS (forwarded to parent via emits) ====================
function openAddModal(mode: 'new' | 'channel', creator?: Creator) {
  emit('add', { mode, creator: creator ?? undefined });
}

function openAvatarPicker(creator: Creator) {
  emit('avatar-picker', creator);
}

function openDeepSyncModal(creator: Creator, specificChannelId?: string) {
  emit('deep-sync', { creator, channelId: specificChannelId });
}

function openEditCreatorTags(creator: Creator) {
  emit('edit-tags', creator);
}

function handleRefreshCreator(creatorId: string) {
  emit('refresh-creator', creatorId);
}

function handleRefreshChannel(channel: Channel, forceRefresh = false) {
  emit('refresh-channel', { channel, force: forceRefresh });
}

function deleteCreator(creatorId: string) {
  emit('delete-creator', creatorId);
}

function deleteChannel(channelId: string) {
  emit('delete-channel', channelId);
}

function cycleChannelRole(channel: Channel) {
  emit('cycle-channel-role', channel);
}

function loadDemoData() {
  emit('demo-data');
}
</script>

<template>
  <section class="space-y-4">
    <!-- Header row, filter bar and batch toolbar. Stateless: every value comes from
         `toolbarContext` and every change goes back through it, so the filter state
         has exactly one home (useCreatorDirectoryFilters). -->
    <CreatorDirectoryToolbar :context="toolbarContext" />

    <!-- Empty Creators State -->
    <div v-if="context.creators.length === 0" class="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
      <Users class="w-10 h-10 text-slate-400 mx-auto mb-3" />
      <p class="text-xs text-slate-500 mb-4">还没有关注任何创作者</p>
      <button
        @click="loadDemoData"
        class="px-4 py-2 text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300 rounded-xl cursor-pointer"
      >
        导入演示数据
      </button>
    </div>

    <!-- Empty Filter Results -->
    <div v-else-if="filteredCreatorsList.length === 0" class="text-center py-16 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
      <Search class="w-8 h-8 text-slate-400 mx-auto mb-2" />
      <p class="text-xs text-slate-500 mb-3">未找到匹配的创作者</p>
      <button
        @click="creatorSearch = ''; creatorPlatformFilter = 'all'; creatorTagFilter = 'all'; clearAllTagFilters();"
        class="px-3 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 dark:bg-indigo-950/50 rounded-lg hover:underline cursor-pointer"
      >
        清除筛选
      </button>
    </div>

    <!-- 1. Grid Tiles View — rendered by CreatorGridView: stateless, driven entirely
         by `gridContext`. -->
    <CreatorGridView v-else-if="viewMode === 'grid'" :context="gridContext" />


    <!-- 2. Compact Table List View — rendered by CreatorListView: stateless, driven
         entirely by `listContext`. -->
    <CreatorListView v-else-if="viewMode === 'list'" :context="listContext" />


    <!-- 3. Detailed Cards View (The complete accordion layout) -->
    <div v-else class="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-3 gap-4 xl:gap-5 items-start">
      <div
        v-for="(colCreators, colIdx) in detailedColumns"
        :key="'detail-col-' + colIdx"
        class="flex flex-col gap-4 xl:gap-5 min-w-0"
      >
        <div
          v-for="c in colCreators"
          :key="c.id"
          :draggable="creatorSortBy === 'manual'"
          @dragstart="onCreatorDragStart(c.id)"
          @dragover="(e: DragEvent) => onCreatorDragOver(e, c.id)"
          @dragleave="dragOverCreatorId === c.id && (dragOverCreatorId = null)"
          @drop="onCreatorDrop(c.id)"
          @dragend="dragCreatorId = null; dragOverCreatorId = null"
          class="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-sm space-y-3 relative overflow-hidden"
          :class="[
            selectedCreatorIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md',
            dragOverCreatorId === c.id ? 'ring-2 ring-indigo-400 border-dashed' : '',
          ]"
        >
        <!-- Top Row: Avatar, Name, Stats & Actions -->
        <CreatorCardHeader
          :creator="c"
          variant="detailed"
          :post-count="context.creatorPostCountMap[c.id] || 0"
          :avatar-url="getCreatorAvatar(c)"
          :is-batch-mode="isBatchMode"
          :is-selected="selectedCreatorIds.has(c.id)"
          :is-updating="getCreatorSyncSummary(c.id).isUpdating"
          @toggle-select="toggleSelectCreator"
          @avatar-picker="openAvatarPicker"
          @avatar-error="handleAvatarError"
          @refresh="handleRefreshCreator"
          @deep-sync="openDeepSyncModal"
          @edit-tags="openEditCreatorTags"
          @delete="deleteCreator"
        />

        <!-- Inline tag chips (detailed variant) -->
        <div class="flex flex-wrap items-center gap-1 mt-1">
          <span
            v-for="t in c.tags"
            :key="t"
            class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
            @click="cycleTagFilter(t)"
            :title="'点击过滤标签 #' + t"
          >
            #{{ t }}
          </span>
          <span v-if="!c.tags?.length" class="text-[10px] text-slate-400">未分类</span>
          <button
            type="button"
            @click.stop="openEditCreatorTags(c)"
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
            <button @click="openAddModal('channel', c)" class="text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-semibold flex items-center gap-1 cursor-pointer bg-indigo-50 dark:bg-indigo-950/60 px-2 py-1 rounded-lg border border-indigo-100 dark:border-indigo-900 transition-colors">
              <Plus class="w-3 h-3" />
              <span>+ 绑定新账号</span>
            </button>
          </div>

          <!-- Grouped Platform Sections -->
          <div class="space-y-2">
            <div
              v-for="(chs, platform) in getCreatorGroupedChannels(c.id)"
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
                    {{ chs.length > 1 ? `绑定了 ${chs.length} 个账号 (同平台多账号互通)` : '1 个账号' }}
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
                  :failed-avatar-urls="failedAvatarUrls"
                  @deep-sync="() => openDeepSyncModal(c, ch.id)"
                  @refresh="payload => handleRefreshChannel(payload.channel, payload.force)"
                  @delete="deleteChannel"
                  @cycle-role="cycleChannelRole"
                  @avatar-error="handleAvatarError"
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
  </section>
</template>
