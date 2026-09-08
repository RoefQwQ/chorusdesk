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
  type Platform,
  type Creator,
  type Channel,
} from '../../../src/types';
import { toSecureMediaUrl } from '../../../src/utils/media';
import {
  RefreshCw,
  Plus,
  CheckSquare,
  Search,
  X,
  ArrowUpDown,
  Filter,
  Tag,
  Trash2,
  Users,
  Square,
  Camera,
  Edit3,
  History,
  ExternalLink,
  AlertCircle,
  LayoutGrid,
  List,
  LayoutList,
  ChevronDown,
  ChevronUp,
} from 'lucide-vue-next';

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
  (e: 'demo-data'): void;
}>();

// ==================== CREATORS DIRECTORY FILTER & SORT & BATCH STATE ====================
const VIEW_MODE_STORAGE_KEY = 'creator_feed_creators_view_mode';
const viewMode = ref<'grid' | 'list' | 'detailed'>(
  (typeof localStorage !== 'undefined' && (localStorage.getItem(VIEW_MODE_STORAGE_KEY) as any)) || 'grid'
);

function setViewMode(mode: 'grid' | 'list' | 'detailed') {
  viewMode.value = mode;
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {}
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

const creatorSearch = ref('');
const creatorPlatformFilter = ref('all');
const creatorTagFilter = ref('all');
const creatorSortBy = ref<'updated' | 'channels' | 'posts' | 'name'>('updated');
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

  // 4. Sorting
  list.sort((a, b) => {
    if (creatorSortBy.value === 'channels') {
      const countA = (creatorChannelMap.value[a.id] || []).length;
      const countB = (creatorChannelMap.value[b.id] || []).length;
      return countB - countA;
    }
    if (creatorSortBy.value === 'posts') {
      const countA = context.value.creatorPostCountMap[a.id] || 0;
      const countB = context.value.creatorPostCountMap[b.id] || 0;
      return countB - countA;
    }
    if (creatorSortBy.value === 'name') {
      return (a.name || '').localeCompare(b.name || '');
    }
    // 'updated': latest channel lastCheckAt or creator updatedAt
    const timeA = Math.max(a.updatedAt || 0, ...(creatorChannelMap.value[a.id] || []).map(ch => ch.lastCheckAt || 0));
    const timeB = Math.max(b.updatedAt || 0, ...(creatorChannelMap.value[b.id] || []).map(ch => ch.lastCheckAt || 0));
    return timeB - timeA;
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

// Account role & multi-account grouping helpers
function getRoleLabel(role?: string, label?: string) {
  if (label) return label;
  switch (role) {
    case 'sub': return '日常小号';
    case 'alt': return '里号/差分';
    case 'custom': return '自定义频道';
    default: return '主账号';
  }
}

function getRoleBadgeClass(role?: string) {
  switch (role) {
    case 'sub': return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-800';
    case 'alt': return 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-950/60 dark:text-rose-300 dark:border-rose-800';
    case 'custom': return 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/60 dark:text-purple-300 dark:border-purple-800';
    default: return 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800';
  }
}

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
  <section class="space-y-6">
    <!-- Header & Action Toolbar -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div class="flex items-center gap-2.5 flex-wrap">
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
          <div class="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
            <ArrowUpDown class="w-3.5 h-3.5 text-slate-400" />
            <span class="text-[11px] text-slate-400 font-medium">排序</span>
            <select
              v-model="creatorSortBy"
              class="bg-transparent border-none text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="updated">最近活跃</option>
              <option value="posts">作品数量</option>
              <option value="channels">账号数量</option>
              <option value="name">字母名称</option>
            </select>
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
          class="p-3 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-2xs space-y-2.5 relative flex flex-col"
          :class="selectedCreatorIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-xs'"
        >
        <div>
          <!-- Header Row: Checkbox / Avatar / Name / Actions -->
          <div class="flex items-start justify-between gap-2">
            <div class="flex items-center gap-2.5 min-w-0">
              <!-- Batch Checkbox -->
              <button
                v-if="isBatchMode"
                @click="toggleSelectCreator(c.id)"
                class="shrink-0 text-indigo-600 hover:scale-105 transition-transform cursor-pointer"
              >
                <CheckSquare v-if="selectedCreatorIds.has(c.id)" class="w-4 h-4 text-indigo-600" />
                <Square v-else class="w-4 h-4 text-slate-400" />
              </button>

              <!-- Avatar with Change Overlay -->
              <div
                class="relative group/avatar w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-50 to-violet-100 dark:from-indigo-950/70 dark:to-violet-900/50 flex items-center justify-center text-indigo-600 font-black text-sm overflow-hidden border border-indigo-100 dark:border-indigo-900 shrink-0 shadow-inner cursor-pointer"
                @click.stop="openAvatarPicker(c)"
                title="更换主头像"
              >
                <img
                  v-if="getCreatorAvatar(c)"
                  :src="getCreatorAvatar(c)"
                  referrerpolicy="no-referrer"
                  @error="handleAvatarError(getCreatorAvatar(c))"
                  class="w-full h-full object-cover transition-transform duration-200 group-hover/avatar:scale-105"
                />
                <span v-else>{{ c.name.slice(0, 1) }}</span>
                <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center text-white">
                  <Camera class="w-3.5 h-3.5 drop-shadow" />
                </div>
              </div>

              <!-- Name & Post Count -->
              <div class="min-w-0">
                <div class="flex items-center gap-1.5">
                  <h3 class="font-bold text-sm text-slate-900 dark:text-white truncate" :title="c.name">{{ c.name }}</h3>
                </div>
                <div class="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <span class="font-medium text-slate-600 dark:text-slate-300">{{ context.creatorPostCountMap[c.id] || 0 }} 篇作品</span>
                  <span>•</span>
                  <span :title="'上次检查：' + (getCreatorSyncSummary(c.id).lastCheckAt ? new Date(getCreatorSyncSummary(c.id).lastCheckAt).toLocaleString('zh-CN') : '尚未检查')">
                    {{ formatRelativeTime(getCreatorSyncSummary(c.id).lastCheckAt) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- Action Buttons -->
            <div class="flex items-center gap-0.5 shrink-0">
              <!-- Sync Creator -->
              <button
                @click="handleRefreshCreator(c.id)"
                :title="getCreatorSyncSummary(c.id).isUpdating ? '正在同步中...' : '同步该创作者所有账号'"
                class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': getCreatorSyncSummary(c.id).isUpdating }" />
              </button>
              <!-- Deep Sync Modal Trigger -->
              <button
                @click="openDeepSyncModal(c)"
                title="回溯更早历史作品"
                class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <History class="w-3.5 h-3.5" />
              </button>
              <!-- Edit Tags -->
              <button
                @click="openEditCreatorTags(c)"
                title="编辑创作者标签"
                class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
              >
                <Edit3 class="w-3.5 h-3.5" />
              </button>
              <!-- Delete Creator -->
              <button
                @click="deleteCreator(c.id)"
                title="移除创作者"
                class="p-1.5 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-lg transition-colors cursor-pointer"
              >
                <Trash2 class="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

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
                <span
                  :class="PLATFORM_REGISTRY[platform as Platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'"
                  class="px-1.5 py-0.5 rounded text-[9px] font-bold border flex items-center gap-1"
                  :title="`${PLATFORM_REGISTRY[platform as Platform]?.name || platform} (${chs.length}个账号)`"
                >
                  <span>{{ PLATFORM_REGISTRY[platform as Platform]?.name || platform }}</span>
                  <span v-if="chs.length > 1" class="text-[8px] opacity-75 font-mono">x{{ chs.length }}</span>
                </span>
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
                class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer flex items-center gap-0.5 text-[10px]"
                :title="expandedCreatorIds.has(c.id) ? '收起账号详情' : '展开管理各平台账号'"
              >
                <span class="font-mono text-[10px]">{{ context.channels.filter(ch => ch.creatorId === c.id).length }}</span>
                <ChevronDown class="w-3 h-3 transition-transform duration-200" :class="{ 'rotate-180': expandedCreatorIds.has(c.id) }" />
              </button>
            </div>
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
            <div
              v-for="ch in context.channels.filter(ch => ch.creatorId === c.id)"
              :key="ch.id"
              class="p-1.5 rounded-lg bg-slate-50 dark:bg-slate-800/80 border border-slate-200/60 dark:border-slate-700/60 text-xs space-y-1"
            >
              <div class="flex items-center justify-between gap-1">
                <div class="flex items-center gap-1.5 min-w-0 flex-1">
                  <!-- Role Badge with Quick Cycle -->
                  <button
                    @click="cycleChannelRole(ch)"
                    title="点击切换账号角色"
                    class="px-1 py-0.2 rounded text-[9px] font-medium border cursor-pointer shrink-0"
                    :class="getRoleBadgeClass(ch.accountRole)"
                  >
                    {{ ch.label || getRoleLabel(ch.accountRole) }}
                  </button>

                  <a
                    :href="ch.profileUrl"
                    target="_blank"
                    class="font-medium text-[11px] text-slate-700 dark:text-slate-200 hover:underline truncate max-w-[110px]"
                    :title="ch.profileUrl"
                  >
                    {{ ch.displayName || ch.accountId }}
                  </a>
                </div>

                <div class="flex items-center gap-0.5 shrink-0">
                  <button
                    @click="openDeepSyncModal(c, ch.id)"
                    title="深度挖掘该账号历史动态"
                    class="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
                  >
                    <History class="w-3 h-3" />
                  </button>
                  <button
                    @click="handleRefreshChannel(ch, false)"
                    @click.shift.stop="handleRefreshChannel(ch, true)"
                    title="同步最新 (按住 Shift 强制覆盖)"
                    class="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
                  >
                    <RefreshCw class="w-3 h-3" :class="{ 'animate-spin': ch.status === 'updating' || context.syncingChannelIds?.has(ch.id) }" />
                  </button>
                  <button
                    @click="deleteChannel(ch.id)"
                    title="移除账号"
                    class="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
                  >
                    <Trash2 class="w-3 h-3" />
                  </button>
                </div>
              </div>

              <!-- Error alert if present -->
              <div
                v-if="ch.errorMessage"
                class="text-[9px] text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 p-1 rounded border border-rose-200/60 dark:border-rose-900/40 flex items-start gap-1"
              >
                <AlertCircle class="w-2.5 h-2.5 shrink-0 mt-0.5" />
                <span class="break-all">{{ ch.errorMessage }}</span>
              </div>
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
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-56 sm:w-64">创作者</th>
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300">已绑平台账号</th>
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-24 text-center">作品数</th>
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-32">同步状态</th>
              <th class="py-2.5 px-3 font-semibold text-slate-700 dark:text-slate-300 w-36 text-right pr-4">操作</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-slate-100 dark:divide-slate-800">
            <template v-for="c in filteredCreatorsList" :key="'row-' + c.id">
              <tr
                class="hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-colors group"
                :class="{ 'bg-indigo-50/20 dark:bg-indigo-950/20': selectedCreatorIds.has(c.id) }"
              >
                <!-- Batch Checkbox -->
                <td v-if="isBatchMode" class="py-2.5 px-3 text-center">
                  <button @click="toggleSelectCreator(c.id)" class="cursor-pointer text-indigo-600">
                    <CheckSquare v-if="selectedCreatorIds.has(c.id)" class="w-4 h-4 text-indigo-600" />
                    <Square v-else class="w-4 h-4 text-slate-400" />
                  </button>
                </td>

                <!-- Creator Avatar, Name & Tags -->
                <td class="py-2.5 px-3">
                  <div class="flex items-center gap-2.5 min-w-0">
                    <div
                      class="relative w-8 h-8 rounded-lg overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 cursor-pointer shadow-2xs"
                      @click="openAvatarPicker(c)"
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

                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5 flex-wrap">
                        <span class="font-semibold text-xs text-slate-900 dark:text-slate-100 truncate max-w-[130px] sm:max-w-[180px]">{{ c.name }}</span>
                        <!-- Quick Tag List -->
                        <span
                          v-for="t in (c.tags || []).slice(0, 2)"
                          :key="t"
                          class="px-1.5 py-0.5 rounded text-[10px] font-normal bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-indigo-600 transition-colors cursor-pointer border border-slate-200/50 dark:border-slate-700/50"
                          @click="cycleTagFilter(t)"
                        >
                          #{{ t }}
                        </span>
                      </div>
                    </div>
                  </div>
                </td>

                <!-- Attached Platform Badges -->
                <td class="py-2.5 px-3">
                  <div class="flex items-center gap-1.5 flex-wrap">
                    <template v-for="(chs, platform) in getCreatorGroupedChannels(c.id)" :key="platform">
                      <span
                        :class="PLATFORM_REGISTRY[platform as Platform]?.badgeBg || 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700'"
                        class="px-1.5 py-0.5 rounded text-[10px] font-medium border flex items-center gap-0.5 shadow-2xs"
                      >
                        {{ PLATFORM_REGISTRY[platform as Platform]?.name || platform }}
                        <span v-if="chs.length > 1" class="text-[9px] opacity-75">x{{ chs.length }}</span>
                      </span>
                    </template>
                    <button
                      @click="toggleExpandCreator(c.id)"
                      class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-medium text-slate-600 dark:text-slate-300 bg-slate-100 hover:bg-indigo-50 hover:text-indigo-600 dark:bg-slate-800 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-400 border border-slate-200/70 dark:border-slate-700/70 transition-colors cursor-pointer ml-1 shadow-2xs"
                    >
                      <span>{{ expandedCreatorIds.has(c.id) ? '收起明细' : '查看全部' }}</span>
                      <span class="text-[10px] text-slate-400">({{ context.channels.filter(ch => ch.creatorId === c.id).length }})</span>
                      <ChevronDown class="w-3 h-3 text-slate-400 transition-transform duration-200" :class="{ 'rotate-180': expandedCreatorIds.has(c.id) }" />
                    </button>
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
                      @click="toggleExpandCreator(c.id)"
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
                      @click="handleRefreshCreator(c.id)"
                      title="同步最新动态"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': getCreatorSyncSummary(c.id).isUpdating }" />
                    </button>
                    <button
                      @click="openDeepSyncModal(c)"
                      title="回溯历史作品"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <History class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click="openAddModal('channel', c)"
                      title="绑定新账号"
                      class="p-1.5 text-slate-500 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <Plus class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click="openEditCreatorTags(c)"
                      title="编辑标签"
                      class="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    >
                      <Edit3 class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click="deleteCreator(c.id)"
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
                <td :colspan="isBatchMode ? 6 : 5" class="p-3">
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
                      <div
                        v-for="ch in context.channels.filter(ch => ch.creatorId === c.id)"
                        :key="ch.id"
                        class="p-2 rounded-lg bg-slate-50 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700 flex items-center justify-between gap-2 text-xs"
                      >
                        <div class="flex items-center gap-2 min-w-0 flex-1">
                          <button
                            @click="cycleChannelRole(ch)"
                            title="点击切换角色"
                            class="px-1.5 py-0.5 rounded text-[10px] font-medium border cursor-pointer shrink-0"
                            :class="getRoleBadgeClass(ch.accountRole)"
                          >
                            {{ ch.label || getRoleLabel(ch.accountRole) }}
                          </button>
                          <span :class="PLATFORM_REGISTRY[ch.platform]?.badgeBg" class="px-1 py-0.2 rounded text-[9px] font-bold border shrink-0">
                            {{ PLATFORM_REGISTRY[ch.platform]?.name || ch.platform }}
                          </span>
                          <a :href="ch.profileUrl" target="_blank" class="font-medium text-slate-700 dark:text-slate-200 hover:underline truncate max-w-[140px]">
                            {{ ch.displayName || ch.accountId }}
                          </a>
                          <span v-if="ch.status === 'error'" class="px-1 py-0.2 text-[9px] bg-rose-50 text-rose-600 rounded border border-rose-200 shrink-0">
                            异常
                          </span>
                        </div>

                        <div class="flex items-center gap-1 shrink-0">
                          <button
                            @click="openDeepSyncModal(c, ch.id)"
                            title="针对该账号回溯历史"
                            class="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
                          >
                            <History class="w-3.5 h-3.5" />
                          </button>
                          <button
                            @click="handleRefreshChannel(ch, false)"
                            @click.shift.stop="handleRefreshChannel(ch, true)"
                            title="同步最新 (按住 Shift 强制覆盖)"
                            class="p-1 text-slate-400 hover:text-indigo-600 rounded cursor-pointer"
                          >
                            <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': ch.status === 'updating' || context.syncingChannelIds?.has(ch.id) }" />
                          </button>
                          <button
                            @click="deleteChannel(ch.id)"
                            title="移除账号"
                            class="p-1 text-slate-400 hover:text-rose-600 rounded cursor-pointer"
                          >
                            <Trash2 class="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
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
          class="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-sm space-y-3 relative overflow-hidden"
          :class="selectedCreatorIds.has(c.id) ? 'border-indigo-500 ring-2 ring-indigo-500/20 bg-indigo-50/20 dark:bg-indigo-950/20' : 'border-slate-200/80 dark:border-slate-800 hover:border-indigo-300 dark:hover:border-indigo-700 hover:shadow-md'"
        >
        <!-- Top Row: Avatar, Name, Stats & Actions -->
        <div class="flex items-start justify-between gap-3">
          <div class="flex items-center gap-3 min-w-0">
            <!-- Checkbox in Batch Mode -->
            <button
              v-if="isBatchMode"
              @click="toggleSelectCreator(c.id)"
              class="shrink-0 text-indigo-600 hover:scale-105 transition-transform cursor-pointer"
            >
              <CheckSquare v-if="selectedCreatorIds.has(c.id)" class="w-5 h-5 text-indigo-600" />
              <Square v-else class="w-5 h-5 text-slate-400" />
            </button>

            <!-- Avatar with Hover Change Overlay -->
            <div
              class="relative group/avatar w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-50 to-violet-100 dark:from-indigo-950/70 dark:to-violet-900/50 flex items-center justify-center text-indigo-600 font-black text-lg overflow-hidden border border-indigo-100 dark:border-indigo-900 shrink-0 shadow-inner cursor-pointer"
              @click.stop="openAvatarPicker(c)"
              title="更换主头像"
            >
              <img
                v-if="getCreatorAvatar(c)"
                :src="getCreatorAvatar(c)"
                referrerpolicy="no-referrer"
                @error="handleAvatarError(getCreatorAvatar(c))"
                class="w-full h-full object-cover transition-transform duration-200 group-hover/avatar:scale-105"
              />
              <span v-else>{{ c.name.slice(0, 1) }}</span>
              <div class="absolute inset-0 bg-black/40 opacity-0 group-hover/avatar:opacity-100 transition-opacity flex items-center justify-center text-white">
                <Camera class="w-4 h-4 drop-shadow" />
              </div>
            </div>

            <!-- Name & Meta Tags -->
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <h3 class="font-bold text-base text-slate-900 dark:text-white truncate">{{ c.name }}</h3>
                <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 shrink-0">
                  {{ context.creatorPostCountMap[c.id] || 0 }} 条作品
                </span>
              </div>
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
            </div>
          </div>

          <!-- Top Quick Action Buttons -->
          <div class="flex items-center gap-1 shrink-0">
            <button
              @click="openDeepSyncModal(c)"
              title="回溯更早的历史动态"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 text-xs font-semibold transition-colors cursor-pointer border border-indigo-200/60 dark:border-indigo-800/60 shadow-2xs"
            >
              <History class="w-3.5 h-3.5" />
              <span class="hidden sm:inline">回溯历史</span>
            </button>
            <button
              @click="handleRefreshCreator(c.id)"
              :title="getCreatorSyncSummary(c.id).isUpdating ? '正在同步中...' : '同步最新动态'"
              class="p-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <RefreshCw class="w-4 h-4" :class="{ 'animate-spin': getCreatorSyncSummary(c.id).isUpdating }" />
            </button>
            <button
              @click="deleteCreator(c.id)"
              title="移除该创作者档案"
              class="p-2 text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/60 rounded-xl transition-colors cursor-pointer"
            >
              <Trash2 class="w-4 h-4" />
            </button>
          </div>
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
                <div
                  v-for="ch in chs"
                  :key="ch.id"
                  class="flex items-center justify-between p-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/60 text-xs shadow-2xs"
                >
                  <div class="flex items-center gap-2 min-w-0 flex-1">
                    <button
                      @click="cycleChannelRole(ch)"
                      title="点击切换账号角色分类 (主号 / 小号 / 里号 / 自定义)"
                      class="px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer shrink-0"
                      :class="getRoleBadgeClass(ch.accountRole)"
                    >
                      {{ ch.label || getRoleLabel(ch.accountRole) }}
                    </button>

                    <div class="w-5 h-5 rounded-full overflow-hidden shrink-0 border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-[10px] text-slate-500">
                      <img
                        v-if="ch.avatarUrl && !failedAvatarUrls.has(ch.avatarUrl)"
                        :src="toSecureMediaUrl(ch.avatarUrl)"
                        referrerpolicy="no-referrer"
                        class="w-full h-full object-cover"
                        @error="handleAvatarError(ch.avatarUrl)"
                      />
                      <span v-else>{{ (ch.displayName || ch.accountId || 'U').slice(0, 1) }}</span>
                    </div>

                    <a
                      :href="ch.profileUrl"
                      target="_blank"
                      class="font-medium text-slate-700 dark:text-slate-200 hover:underline flex items-center gap-1 truncate max-w-[150px] sm:max-w-[200px]"
                      :title="ch.profileUrl"
                    >
                      <span class="truncate">{{ ch.displayName || ch.accountId }}</span>
                      <ExternalLink class="w-2.5 h-2.5 text-slate-400 shrink-0" />
                    </a>

                    <span
                      v-if="ch.displayName && ch.accountId && ch.displayName !== ch.accountId"
                      class="text-[11px] text-slate-400 dark:text-slate-500 truncate hidden sm:inline shrink-0 max-w-[130px]"
                      :title="'账号 ID: ' + ch.accountId"
                    >
                      {{ ch.accountId.startsWith('@') ? ch.accountId : '@' + ch.accountId }}
                    </span>

                    <span
                      v-if="ch.status === 'error'"
                      @click.stop="alert(`【${ch.displayName || ch.accountId} 同步未成功】\n\n原因：${ch.errorMessage || '未知异常'}`)"
                      class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-100 cursor-pointer shrink-0"
                      title="点击查看具体同步错误详情"
                    >
                      同步失败
                    </span>

                    <span
                      v-else-if="ch.lastSyncAt"
                      class="text-[10px] text-slate-400 dark:text-slate-500 hidden sm:inline-flex items-center gap-1 shrink-0 ml-auto mr-1"
                      :title="'上次同步：' + new Date(ch.lastSyncAt).toLocaleString('zh-CN')"
                    >
                      <span class="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-600"></span>
                      <span>{{ formatRelativeTime(ch.lastSyncAt) }}</span>
                    </span>
                  </div>

                  <div class="flex items-center gap-1 shrink-0 ml-2">
                    <button
                      @click="openDeepSyncModal(c, ch.id)"
                      title="针对该账号深度回溯更早历史动态"
                      class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <History class="w-3.5 h-3.5" />
                    </button>
                    <button
                      @click="handleRefreshChannel(ch, false)"
                      @click.shift.stop="handleRefreshChannel(ch, true)"
                      title="同步最新动态 (按住 Shift 点击可强制重新刷新覆盖已有内容与图片)"
                      class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': ch.status === 'updating' || context.syncingChannelIds?.has(ch.id) }" />
                    </button>
                    <button
                      @click="deleteChannel(ch.id)"
                      title="移除该账号"
                      class="p-1 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

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
