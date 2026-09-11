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
  ACCOUNT_ROLE_ORDER,
  ACCOUNT_ROLE_SHORT_LABELS,
  type AccountRole,
  type Platform,
  type Creator,
  type Channel,
} from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import { compareManualEntries } from '../../../src/utils/order';
import {
  RefreshCw,
  Plus,
  CheckSquare,
  Search,
  X,
  ArrowUpDown,
  Filter,
  Tag,
  Square,
  Edit3,
  History,
  Trash2,
  AlertCircle,
  Users,
  UserRound,
  ChevronDown,
  ChevronsUpDown,
  LayoutGrid,
  List,
  LayoutList,
} from 'lucide-vue-next';
import AppSelect, { type AppSelectOption } from '../components/AppSelect.vue';
import ChannelRow from '../components/creator/ChannelRow.vue';
import CreatorCardHeader from '../components/creator/CreatorCardHeader.vue';
// Both of these were used in the template without being imported, so they
// resolved to nothing and every 已绑平台账号 cell silently rendered EMPTY in all
// three views, as did the delete icon. `vue-tsc` does not flag an unresolved
// component unless `vueCompilerOptions.strictTemplates` is on (it is now —
// 2026-09-11), which is how this shipped unnoticed through four commits.
import PlatformBadge from '../components/creator/PlatformBadge.vue';

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

// ==================== CREATORS DIRECTORY FILTER & SORT & BATCH STATE ====================
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

const creatorSearch = ref('');
const creatorPlatformFilter = ref('all');
const creatorTagFilter = ref('all');
/** 账号类型筛选：'all' | AccountRole。按创作者名下是否存在该类型账号过滤。 */
const creatorRoleFilter = ref<'all' | AccountRole>('all');
/**
 * Sort state: a column key plus a direction.
 *
 * `platform` and `manual` are not columns — they are orderings that only the
 * toolbar dropdown can express — so the union is wider than the sortable headers.
 * Clicking a header is a shortcut into this same state rather than a second,
 * parallel notion of "order", which is what keeps the dropdown and the header
 * indicators from ever disagreeing.
 *
 * `dir` exists because a one-way sort cannot answer the obvious question. "作品数"
 * is useful both as most-posts-first and fewest-first, and "创作者" both A→Z and
 * Z→A; without a direction the headers could only ever offer one of the two.
 */
type CreatorSortKey = 'updated' | 'posts' | 'channels' | 'name' | 'tags' | 'platform' | 'manual';

// Typed against `CreatorSortKey` so the generic `AppSelect` can prove the options
// match the ref it is bound to: without the annotation Vue widens `value` to
// `string`, and a typo here would be accepted silently.
const creatorSortOptions: AppSelectOption<CreatorSortKey>[] = [
  { value: 'updated', label: '最近活跃' },
  { value: 'posts', label: '作品数量' },
  { value: 'channels', label: '账号数量' },
  { value: 'name', label: '字母名称' },
  { value: 'tags', label: '标签' },
  { value: 'platform', label: '按平台分组' },
  { value: 'manual', label: '手动排序' },
];
const creatorSortBy = ref<CreatorSortKey>('updated');
const creatorSortDir = ref<'asc' | 'desc'>('desc');

/** The direction a column should default to when first clicked. */
function defaultSortDir(key: CreatorSortKey): 'asc' | 'desc' {
  // Text reads naturally A→Z; counts and timestamps are almost always wanted
  // largest/newest first.
  return key === 'name' || key === 'tags' ? 'asc' : 'desc';
}

/**
 * Header click: sort by that column, or flip the direction if already sorted by
 * it. Matches the behaviour every data table has, so it needs no learning.
 */
function toggleSort(key: CreatorSortKey) {
  if (creatorSortBy.value === key) {
    creatorSortDir.value = creatorSortDir.value === 'asc' ? 'desc' : 'asc';
    return;
  }
  creatorSortBy.value = key;
  creatorSortDir.value = defaultSortDir(key);
}

/** True when `key` is the active sort column — the header that shows an arrow. */
function isSortedBy(key: CreatorSortKey): boolean {
  return creatorSortBy.value === key;
}

/** `aria-sort` value for a header, per the W3C sortable-table pattern. */
function ariaSortFor(key: CreatorSortKey): 'ascending' | 'descending' | 'none' {
  if (!isSortedBy(key)) return 'none';
  return creatorSortDir.value === 'asc' ? 'ascending' : 'descending';
}

/**
 * The toolbar dropdown's binding.
 *
 * Bound to the same state the headers write, so the two can never disagree, and
 * picking a key here also applies that key's natural direction — otherwise
 * choosing 「字母名称」 after sorting by 作品数 would silently give Z→A.
 */
const sortSelection = computed<CreatorSortKey>({
  get: () => creatorSortBy.value,
  set: (key) => {
    creatorSortBy.value = key;
    creatorSortDir.value = defaultSortDir(key);
  },
});
/** 批量选择模式：开启后每行/卡片显示复选框，工具栏切换为批量操作。 */
const isBatchMode = ref(false);
const selectedCreatorIds = ref<Set<string>>(new Set());
const includeTags = ref<Set<string>>(new Set());
const excludeTags = ref<Set<string>>(new Set());
const failedAvatarUrls = ref<Set<string>>(new Set());

// All available tags
const allTags = computed(() => {
  const set = new Set<string>();
  context.value.creators.forEach(c => c.tags?.forEach(t => set.add(t)));
  return Array.from(set);
});

// Tag filtering tri-state helpers (neutral -> include -> exclude -> neutral)
function cycleTagFilter(t: string) {
  if (includeTags.value.has(t)) {
    includeTags.value.delete(t);
    excludeTags.value.add(t);
  } else if (excludeTags.value.has(t)) {
    excludeTags.value.delete(t);
  } else {
    includeTags.value.add(t);
  }
  includeTags.value = new Set(includeTags.value);
  excludeTags.value = new Set(excludeTags.value);
}

function clearAllTagFilters() {
  includeTags.value = new Set();
  excludeTags.value = new Set();
}

function getTagFilterState(t: string): 'include' | 'exclude' | 'none' {
  if (includeTags.value.has(t)) return 'include';
  if (excludeTags.value.has(t)) return 'exclude';
  return 'none';
}

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

// Platform count map per creator
const creatorChannelMap = computed(() => {
  const map: Record<string, Channel[]> = {};
  for (const ch of context.value.channels) {
    if (!map[ch.creatorId]) map[ch.creatorId] = [];
    map[ch.creatorId].push(ch);
  }
  return map;
});

// Creators per account role (filter pill badges) — counts creators, not channels.
const creatorCountByRole = computed<Record<string, number>>(() => {
  const counts: Record<string, number> = { all: context.value.creators.length };
  for (const role of ACCOUNT_ROLE_ORDER) counts[role] = 0;
  for (const c of context.value.creators) {
    const roles = new Set(
      context.value.channels.filter(ch => ch.creatorId === c.id).map(ch => ch.accountRole || 'main')
    );
    for (const r of roles) counts[r] = (counts[r] || 0) + 1;
  }
  return counts;
});

// Filtered and sorted creators list for Directory tab
const filteredCreatorsList = computed(() => {
  let list = [...context.value.creators];

  // 1. Search filter (matches creator name, tag, or channel account/displayName)
  if (creatorSearch.value.trim()) {
    const q = creatorSearch.value.trim().toLowerCase();
    list = list.filter(c => {
      const matchName = (c.name || '').toLowerCase().includes(q);
      const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
      const matchCh = context.value.channels.some(
        ch => ch.creatorId === c.id && ((ch.displayName || '').toLowerCase().includes(q) || ch.accountId.toLowerCase().includes(q))
      );
      return matchName || matchTag || matchCh;
    });
  }

  // 2. Platform filter
  if (creatorPlatformFilter.value !== 'all') {
    list = list.filter(c => {
      return context.value.channels.some(ch => ch.creatorId === c.id && ch.platform === creatorPlatformFilter.value);
    });
  }

  // 3. Tag filter (positive inclusion & negative exclusion)
  if (excludeTags.value.size > 0) {
    list = list.filter(c => {
      const cTags = c.tags || [];
      return !cTags.some(t => excludeTags.value.has(t));
    });
  }
  if (includeTags.value.size > 0) {
    list = list.filter(c => {
      const cTags = c.tags || [];
      return cTags.some(t => includeTags.value.has(t));
    });
  }
  if (creatorTagFilter.value !== 'all') {
    list = list.filter(c => c.tags?.includes(creatorTagFilter.value));
  }

  // 4. Account-type filter: creator has at least one channel of that role.
  if (creatorRoleFilter.value !== 'all') {
    list = list.filter(c =>
      context.value.channels.some(ch => ch.creatorId === c.id && (ch.accountRole || 'main') === creatorRoleFilter.value)
    );
  }

  // 5. Sorting
  const channelCount = (c: Creator) => (creatorChannelMap.value[c.id] || []).length;
  const postCount = (c: Creator) => context.value.creatorPostCountMap[c.id] || 0;
  const lastActive = (c: Creator) =>
    Math.max(c.updatedAt || 0, ...(creatorChannelMap.value[c.id] || []).map((ch) => ch.lastCheckAt || 0));

  list.sort((a, b) => {
    if (creatorSortBy.value === 'platform') {
      // Group by the creator's first platform (in user's sidebar order),
      // newest-active within the group.
      const rank = (c: Creator) => {
        const platforms = (creatorChannelMap.value[c.id] || []).map((ch) => ch.platform);
        const order = context.value.platformOrder.length > 0 ? context.value.platformOrder : Object.keys(PLATFORM_REGISTRY);
        let best = order.length;
        for (const p of platforms) {
          const i = order.indexOf(p);
          if (i !== -1 && i < best) best = i;
        }
        return best;
      };
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return lastActive(b) - lastActive(a);
    }
    if (creatorSortBy.value === 'manual') {
      // Shared with the persistence layer; must not return NaN when both
      // records lack a sortOrder (the pre-drag state of every creator).
      return compareManualEntries(a, b);
    }

    // Column sorts. Each branch states its comparison in ascending terms and the
    // direction is applied once, so adding a column cannot forget the arrow.
    let ascending: number;
    switch (creatorSortBy.value) {
      case 'name':
        ascending = (a.name || '').localeCompare(b.name || '', 'zh');
        break;
      case 'tags':
        ascending = ((a.tags || [])[0] || '').localeCompare((b.tags || [])[0] || '', 'zh');
        break;
      case 'channels':
        ascending = channelCount(a) - channelCount(b);
        break;
      case 'posts':
        ascending = postCount(a) - postCount(b);
        break;
      default:
        ascending = lastActive(a) - lastActive(b);
    }
    // A stable tie-break keeps the order deterministic between renders; without
    // it, rows with equal keys shuffle as the list re-sorts.
    if (ascending === 0) return (a.name || '').localeCompare(b.name || '', 'zh');
    return creatorSortDir.value === 'asc' ? ascending : -ascending;
  });

  return list;
});

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
 * 聚合分析创作者旗下全部频道的同步健康状况
 */
function getCreatorSyncSummary(creatorId: string) {
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
    <!-- Header & Action Toolbar (single compact row) -->
    <div class="flex flex-wrap items-center justify-between gap-2.5">
      <div class="flex items-center gap-2 flex-wrap">
        <h2 class="font-bold text-lg text-slate-900 dark:text-white">关注管理</h2>
        <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
          {{ filteredCreatorsList.length }} / {{ context.creators.length }} 位创作者
        </span>
      </div>

      <!-- Right Action Group: View Mode Switcher + Batch Mode + Add Button -->
      <div class="flex items-center gap-2 flex-wrap">
        <!-- View Mode Switcher -->
        <div class="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-700/80 shadow-2xs">
          <button
            type="button"
            @click="setViewMode('grid')"
            :class="viewMode === 'grid' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
            title="网格磁贴视图 (中等密度，清晰直观)"
          >
            <LayoutGrid class="w-3.5 h-3.5" />
            <span class="hidden md:inline">网格</span>
          </button>
          <button
            type="button"
            @click="setViewMode('list')"
            :class="viewMode === 'list' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
            title="紧凑列表视图 (超高密度，一屏容纳 20+ 位创作者)"
          >
            <List class="w-3.5 h-3.5" />
            <span class="hidden md:inline">紧凑列表</span>
          </button>
          <button
            type="button"
            @click="setViewMode('detailed')"
            :class="viewMode === 'detailed' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
            title="详细卡片视图 (完全展开全部账号与角色管理)"
          >
            <LayoutList class="w-3.5 h-3.5" />
            <span class="hidden md:inline">详细卡片</span>
          </button>
        </div>

        <button
          @click="isBatchMode = !isBatchMode; if (!isBatchMode) selectedCreatorIds = new Set();"
          :class="isBatchMode ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'"
          class="flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
        >
          <CheckSquare class="w-3.5 h-3.5" />
          <span>{{ isBatchMode ? '完成批量' : '批量操作' }}</span>
        </button>

        <button
          @click="openAddModal('new')"
          class="flex items-center gap-1.5 px-3.5 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
        >
          <Plus class="w-4 h-4" />
          <span>+ 关注创作者</span>
        </button>
      </div>
    </div>

    <!-- Filter & Search Bar (Streamlined high-density bar) -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-3 shadow-2xs space-y-2.5">
      <div class="flex flex-col md:flex-row items-stretch md:items-center gap-2.5">
        <!-- Search Input -->
        <div class="relative flex-1">
          <Search class="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="creatorSearch"
            type="text"
            placeholder="快速搜索创作者名称、标签或账号..."
            class="w-full pl-8 pr-8 py-1.5 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
          />
          <button
            v-if="creatorSearch"
            @click="creatorSearch = ''"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>

        <!-- Sort By Select -->
        <div class="flex items-center gap-2 shrink-0">
          <div class="flex items-center gap-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
            <span class="pl-2.5 text-[11px] text-slate-400 font-medium flex items-center gap-1">
              <ArrowUpDown class="w-3.5 h-3.5" />
              排序
            </span>
            <AppSelect
              v-model="sortSelection"
              :options="creatorSortOptions"
              aria-label="创作者排序方式"
              button-class="py-1.5 pr-2 pl-0.5 text-xs bg-transparent dark:bg-transparent border-none hover:border-transparent dark:hover:border-transparent"
            />
          </div>

          <!-- Tags Drawer Trigger Button if tags exist -->
          <button
            v-if="allTags.length > 0"
            type="button"
            @click="isTagsExpanded = !isTagsExpanded"
            :class="isTagsExpanded || includeTags.size > 0 || excludeTags.size > 0 ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
            class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer"
            title="展开/收起标签过滤"
          >
            <Tag class="w-3.5 h-3.5" />
            <span>标签</span>
            <span v-if="includeTags.size > 0 || excludeTags.size > 0" class="w-2 h-2 rounded-full bg-indigo-500"></span>
            <ChevronDown class="w-3 h-3 transition-transform duration-200" :class="{ 'rotate-180': isTagsExpanded }" />
          </button>
        </div>
      </div>

      <!-- Platform Filter Pills (Compact Row) -->
      <div class="flex flex-wrap items-center gap-1 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <Filter class="w-3 h-3" />
          平台:
        </span>
        <button
          @click="creatorPlatformFilter = 'all'"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
          :class="creatorPlatformFilter === 'all'
            ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          全部 ({{ context.creators.length }})
        </button>
        <template v-for="(cfg, pKey) in PLATFORM_REGISTRY" :key="pKey">
          <button
            v-if="context.creatorCountByPlatform[pKey]"
            @click="creatorPlatformFilter = pKey"
            class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
            :class="creatorPlatformFilter === pKey
              ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
          >
            <span>{{ cfg.name }}</span>
            <span class="text-[10px] opacity-75">({{ context.creatorCountByPlatform[pKey] || 0 }})</span>
          </button>
        </template>
      </div>

      <!-- Account-Type Filter Pills -->
      <div class="flex flex-wrap items-center gap-1 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <UserRound class="w-3 h-3" />
          账号类型:
        </span>
        <button
          @click="creatorRoleFilter = 'all'"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
          :class="creatorRoleFilter === 'all'
            ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          全部 ({{ context.creators.length }})
        </button>
        <button
          v-for="role in ACCOUNT_ROLE_ORDER"
          :key="'role-' + role"
          @click="creatorRoleFilter = role"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
          :class="creatorRoleFilter === role
            ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          <span>{{ ACCOUNT_ROLE_SHORT_LABELS[role] }}</span>
          <span class="text-[10px] opacity-75">({{ creatorCountByRole[role] || 0 }})</span>
        </button>
      </div>

      <!-- Collapsible Tags Filter Row -->
      <div v-if="allTags.length > 0 && isTagsExpanded" class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs animate-fade-in">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <Tag class="w-3 h-3" />
          标签筛选:
        </span>
        <button
          type="button"
          @click="clearAllTagFilters"
          :class="includeTags.size === 0 && excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
        >
          全部
        </button>
        <button
          v-for="t in allTags"
          :key="'dir-tag-' + t"
          type="button"
          @click="cycleTagFilter(t)"
          :class="[
            getTagFilterState(t) === 'include'
              ? 'bg-indigo-600 text-white font-bold shadow-2xs'
              : getTagFilterState(t) === 'exclude'
              ? 'bg-rose-600 text-white font-bold shadow-2xs line-through'
              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
          ]"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
          :title="getTagFilterState(t) === 'include' ? '正向包含（点击切为反向排除）' : getTagFilterState(t) === 'exclude' ? '反向排除（点击取消）' : '点击设置为正向包含(+)'"
        >
          <span v-if="getTagFilterState(t) === 'include'" class="text-[10px] font-black">+</span>
          <span v-else-if="getTagFilterState(t) === 'exclude'" class="text-[10px] font-black">−</span>
          <span>#{{ t }}</span>
        </button>
      </div>
    </div>

    <!-- Batch Action Toolbar (When Batch Mode Active) -->
    <div
      v-if="isBatchMode"
      class="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-indigo-50/90 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/70 rounded-2xl animate-fade-in"
    >
      <div class="flex items-center gap-3">
        <button
          @click="selectAllFilteredCreators"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-indigo-50 cursor-pointer"
        >
          <CheckSquare class="w-3.5 h-3.5 text-indigo-600" />
          <span>全选 ({{ filteredCreatorsList.length }})</span>
        </button>
        <button
          @click="clearCreatorSelection"
          class="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline cursor-pointer"
        >
          清空选择
        </button>
        <span class="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
          已选 {{ selectedCreatorIds.size }} 位
        </span>
      </div>

      <div class="flex items-center gap-2">
        <button
          @click="batchRefreshSelectedCreators"
          :disabled="selectedCreatorIds.size === 0"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
        >
          <RefreshCw class="w-3.5 h-3.5" />
          <span>同步选中</span>
        </button>
        <button
          @click="batchDeleteSelectedCreators"
          :disabled="selectedCreatorIds.size === 0"
          class="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
        >
          <Trash2 class="w-3.5 h-3.5" />
          <span>删除选中</span>
        </button>
      </div>
    </div>

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

    <!-- 1. Grid Tiles View (Default: 8-16 Creators per screen, compact cards with platform icons and collapsible account details) -->
    <div v-else-if="viewMode === 'grid'" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5 items-start">
      <div
        v-for="(colCreators, colIdx) in gridColumns"
        :key="'grid-col-' + colIdx"
        class="flex flex-col gap-3.5 min-w-0"
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
          class="p-3 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-2xs space-y-2.5 relative flex flex-col"
          :class="[
            selectedCreatorIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-xs',
            dragOverCreatorId === c.id ? 'ring-2 ring-indigo-400 border-dashed' : '',
          ]"
        >
        <div>
          <!-- Header Row: Checkbox / Avatar / Name / Actions -->
          <CreatorCardHeader
            :creator="c"
            variant="grid"
            :post-count="context.creatorPostCountMap[c.id] || 0"
            :avatar-url="getCreatorAvatar(c)"
            :is-batch-mode="isBatchMode"
            :is-selected="selectedCreatorIds.has(c.id)"
            :is-updating="getCreatorSyncSummary(c.id).isUpdating"
            :last-check-at="getCreatorSyncSummary(c.id).lastCheckAt"
            @toggle-select="toggleSelectCreator"
            @avatar-picker="openAvatarPicker"
            @avatar-error="handleAvatarError"
            @refresh="handleRefreshCreator"
            @deep-sync="openDeepSyncModal"
            @edit-tags="openEditCreatorTags"
            @delete="deleteCreator"
          />
          <!-- Tags Preview (Compact) -->
          <div v-if="c.tags?.length" class="flex flex-wrap items-center gap-1 mt-1.5">
            <span
              v-for="t in c.tags.slice(0, 3)"
              :key="t"
              class="px-1.5 py-0.2 rounded text-[10px] bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 cursor-pointer hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
              @click="cycleTagFilter(t)"
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
              <template v-for="(chs, platform) in getCreatorGroupedChannels(c.id)" :key="platform">
                <PlatformBadge :platform="platform as string" :count="chs.length" compact />
              </template>
              <span v-if="context.channels.filter(ch => ch.creatorId === c.id).length === 0" class="text-[10px] text-slate-400">
                未绑定账号
              </span>
            </div>

            <!-- Sync Error Badge or Collapsible Account Details Toggle -->
            <div class="flex items-center gap-1 shrink-0">
              <span
                v-if="getCreatorSyncSummary(c.id).hasError"
                @click.stop="toggleExpandCreator(c.id)"
                class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 cursor-pointer flex items-center gap-0.5"
                title="存在同步异常账号，点击展开查看"
              >
                <AlertCircle class="w-2.5 h-2.5" />
                <span>{{ getCreatorSyncSummary(c.id).errorCount }}个异常</span>
              </span>
              <button
                type="button"
                @click="toggleExpandCreator(c.id)"
                class="inline-flex items-center gap-0.5 text-[10px] text-slate-400 hover:text-indigo-600 dark:text-slate-500 dark:hover:text-indigo-400 transition-colors cursor-pointer"
                :title="expandedCreatorIds.has(c.id) ? '收起账号列表' : '展开账号列表'"
              >
                <span>{{ context.channels.filter(ch => ch.creatorId === c.id).length }} 个账号</span>
                <ChevronDown class="w-3 h-3 transition-transform duration-200" :class="{ 'rotate-180': expandedCreatorIds.has(c.id) }" />
              </button>
            </div>
          </div>

        <!-- Expanded Account Details in Grid Mode -->
        <div
          v-if="expandedCreatorIds.has(c.id)"
          class="pt-2 border-t border-slate-100 dark:border-slate-800 space-y-2 animate-fade-in"
        >
          <div class="flex items-center justify-between text-[10px] text-slate-500 pb-1">
            <span class="font-semibold text-slate-700 dark:text-slate-300">绑定的账号列表</span>
            <button
              @click="openAddModal('channel', c)"
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
              @deep-sync="() => openDeepSyncModal(c, ch.id)"
              @refresh="payload => handleRefreshChannel(payload.channel, payload.force)"
              @delete="deleteChannel"
              @cycle-role="cycleChannelRole"
            />
          </div>
        </div>
        </div>
      </div>
    </div>
    </div>

    <!-- 2. Compact Table List View (15-25+ Creators per screen, highest density) -->
    <div v-else-if="viewMode === 'list'" class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs">
          <thead>
            <tr class="border-b border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-800/60 text-[11px] font-semibold text-slate-500 dark:text-slate-400">
              <th v-if="isBatchMode" class="py-2.5 px-3 w-10 text-center">
                <button @click="selectAllFilteredCreators" class="cursor-pointer text-indigo-600">
                  <CheckSquare class="w-3.5 h-3.5" />
                </button>
              </th>
              <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-56 sm:w-64" :aria-sort="ariaSortFor('name')">
                <button
                  type="button"
                  class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                  title="按创作者名称排序"
                  @click="toggleSort('name')"
                >
                  <span>创作者</span>
                  <ChevronDown v-if="isSortedBy('name')" class="w-3 h-3 shrink-0" :class="creatorSortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                  <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                </button>
              </th>
              <th class="p-0 font-semibold text-slate-700 dark:text-slate-300" :aria-sort="ariaSortFor('channels')">
                <button
                  type="button"
                  class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                  title="按已绑定账号数量排序"
                  @click="toggleSort('channels')"
                >
                  <span>已绑平台账号</span>
                  <ChevronDown v-if="isSortedBy('channels')" class="w-3 h-3 shrink-0" :class="creatorSortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                  <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                </button>
              </th>
              <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-40" :aria-sort="ariaSortFor('tags')">
                <button
                  type="button"
                  class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                  title="按标签排序"
                  @click="toggleSort('tags')"
                >
                  <span>标签</span>
                  <ChevronDown v-if="isSortedBy('tags')" class="w-3 h-3 shrink-0" :class="creatorSortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                  <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                </button>
              </th>
              <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-24" :aria-sort="ariaSortFor('posts')">
                <button
                  type="button"
                  class="sort-header w-full py-2.5 px-3 flex items-center justify-center gap-1 cursor-pointer"
                  title="按作品数量排序"
                  @click="toggleSort('posts')"
                >
                  <span>作品数</span>
                  <ChevronDown v-if="isSortedBy('posts')" class="w-3 h-3 shrink-0" :class="creatorSortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                  <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                </button>
              </th>
              <th class="p-0 font-semibold text-slate-700 dark:text-slate-300 w-32" :aria-sort="ariaSortFor('updated')">
                <button
                  type="button"
                  class="sort-header w-full py-2.5 px-3 flex items-center gap-1 cursor-pointer text-left"
                  title="按最近同步时间排序"
                  @click="toggleSort('updated')"
                >
                  <span>同步状态</span>
                  <ChevronDown v-if="isSortedBy('updated')" class="w-3 h-3 shrink-0" :class="creatorSortDir === 'asc' ? 'rotate-180' : ''" aria-hidden="true" />
                  <ChevronsUpDown v-else class="w-3 h-3 shrink-0 opacity-40" aria-hidden="true" />
                </button>
              </th>
              <!-- Not sortable, so no button and no aria-sort: it holds row actions,
                   not data. -->
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-36 text-right">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <template v-for="c in filteredCreatorsList" :key="'row-' + c.id">
              <tr
                :draggable="creatorSortBy === 'manual'"
                @dragstart="onCreatorDragStart(c.id)"
                @dragover="(e: DragEvent) => onCreatorDragOver(e, c.id)"
                @dragleave="dragOverCreatorId === c.id && (dragOverCreatorId = null)"
                @drop="onCreatorDrop(c.id)"
                @dragend="dragCreatorId = null; dragOverCreatorId = null"
                @click="onRowClick($event, c.id)"
                class="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors group cursor-pointer"
                :class="[
                  { 'bg-indigo-50/20 dark:bg-indigo-950/20': selectedCreatorIds.has(c.id) },
                  dragOverCreatorId === c.id ? 'ring-2 ring-inset ring-indigo-400' : '',
                ]"
              >
                <!-- Batch Checkbox -->
                <td v-if="isBatchMode" class="py-2.5 px-3 text-center">
                  <button @click.stop="toggleSelectCreator(c.id)" class="cursor-pointer text-indigo-600">
                    <CheckSquare v-if="selectedCreatorIds.has(c.id)" class="w-4 h-4 text-indigo-600" />
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
                      :aria-expanded="expandedCreatorIds.has(c.id)"
                      :title="expandedCreatorIds.has(c.id) ? '收起已绑定账号' : '展开已绑定账号'"
                      @click.stop="toggleExpandCreator(c.id)"
                    >
                      <ChevronDown
                        class="w-3.5 h-3.5 transition-transform duration-200"
                        :class="{ 'rotate-180': expandedCreatorIds.has(c.id) }"
                        aria-hidden="true"
                      />
                    </button>

                    <div
                      class="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 cursor-pointer shadow-2xs"
                      @click.stop="openAvatarPicker(c)"
                      title="更换主头像"
                    >
                      <img
                        v-if="getCreatorAvatar(c)"
                        :src="getCreatorAvatar(c)"
                        referrerpolicy="no-referrer"
                        @error="handleAvatarError(getCreatorAvatar(c))"
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
                    <template v-for="(chs, platform) in getCreatorGroupedChannels(c.id)" :key="platform">
                      <PlatformBadge :platform="platform as string" :count="chs.length" />
                    </template>
                    <span v-if="!Object.keys(getCreatorGroupedChannels(c.id)).length" class="text-[11px] text-slate-300 dark:text-slate-600">无账号</span>
                  </div>
                </td>

                <!-- Tags -->
                <td class="py-2.5 px-3">
                  <div class="flex items-center gap-1 flex-wrap">
                    <span
                      v-for="t in c.tags"
                      :key="t"
                      class="px-1.5 py-0.5 rounded text-[10px] font-normal bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-700/50"
                      @click.stop="cycleTagFilter(t)"
                      :title="'点击过滤标签 #' + t"
                    >
                      #{{ t }}
                    </span>
                    <span v-if="!c.tags?.length" class="text-[11px] text-slate-300 dark:text-slate-600">未分类</span>
                  </div>
                </td>

                <!-- Post Count -->
                <td class="py-2.5 px-3 text-center text-slate-600 dark:text-slate-400">
                  <span class="font-semibold text-slate-700 dark:text-slate-200">{{ context.creatorPostCountMap[c.id] || 0 }}</span>
                  <span class="text-[10px] text-slate-400 ml-0.5">篇</span>
                </td>

                <!-- Sync Health & Last Checked -->
                <td class="py-2.5 px-3">
                  <div class="flex items-center gap-1.5">
                    <span
                      v-if="getCreatorSyncSummary(c.id).isUpdating"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-amber-50 text-amber-600 dark:bg-amber-950/50 dark:text-amber-400 border border-amber-200/60 dark:border-amber-900/40"
                    >
                      <RefreshCw class="w-2.5 h-2.5 animate-spin" />
                      <span>同步中</span>
                    </span>
                    <span
                      v-else-if="getCreatorSyncSummary(c.id).hasError"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-medium bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-400 border border-rose-200/60 dark:border-rose-900/40 cursor-pointer hover:bg-rose-100 transition-colors"
                      @click.stop="toggleExpandCreator(c.id)"
                      :title="getCreatorSyncSummary(c.id).firstErrorChannel?.errorMessage"
                    >
                      <AlertCircle class="w-2.5 h-2.5" />
                      <span>异常 ({{ getCreatorSyncSummary(c.id).errorCount }})</span>
                    </span>
                    <span
                      v-else
                      class="inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400"
                    >
                      <span class="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                      <span>{{ formatRelativeTime(getCreatorSyncSummary(c.id).lastCheckAt) }}</span>
                    </span>
                  </div>
                </td>

                <!-- Action Toolbar -->
                <td class="py-2.5 px-3 text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      @click.stop="handleRefreshCreator(c.id)"
                      title="同步最新动态"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': getCreatorSyncSummary(c.id).isUpdating }" />
                    </button>
                    <button
                      @click.stop="openDeepSyncModal(c)"
                      title="回溯历史作品"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <History class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click.stop="openAddModal('channel', c)"
                      title="绑定新账号"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <Plus class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click.stop="openEditCreatorTags(c)"
                      title="编辑标签"
                      class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <Edit3 class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click.stop="deleteCreator(c.id)"
                      title="移除创作者"
                      class="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>

              <!-- Nested Table Row if Expanded -->
              <tr v-if="expandedCreatorIds.has(c.id)" class="bg-slate-50/50 dark:bg-slate-800/40">
                <td :colspan="isBatchMode ? 7 : 6" class="p-3">
                  <div class="rounded-xl border border-slate-200/70 dark:border-slate-800 bg-white dark:bg-slate-900 p-3 space-y-2">
                    <div class="flex items-center justify-between text-xs pb-1 border-b border-slate-100 dark:border-slate-800">
                      <span class="font-bold text-slate-700 dark:text-slate-200">【{{ c.name }}】全部已绑定平台账号</span>
                      <button
                        @click="openAddModal('channel', c)"
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
                        @deep-sync="() => openDeepSyncModal(c, ch.id)"
                        @refresh="payload => handleRefreshChannel(payload.channel, payload.force)"
                        @delete="deleteChannel"
                        @cycle-role="cycleChannelRole"
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
