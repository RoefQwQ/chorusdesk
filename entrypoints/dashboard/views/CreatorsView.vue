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
}
</script>

<script setup lang="ts">
import { ref, computed } from 'vue';
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
  isBatchMode.value = false;
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
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <div class="flex items-center gap-2">
          <h2 class="font-bold text-lg text-slate-900 dark:text-white">关注管理</h2>
          <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
            {{ filteredCreatorsList.length }} / {{ context.creators.length }} 位
          </span>
        </div>
        <p class="text-xs text-slate-500 mt-0.5">管理关注的创作者和绑定的各平台账号</p>
      </div>
      <div class="flex items-center gap-2">
        <button
          @click="isBatchMode = !isBatchMode; if (!isBatchMode) selectedCreatorIds = new Set();"
          :class="isBatchMode ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'"
          class="flex items-center gap-1.5 px-3 py-2 border rounded-xl text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
        >
          <CheckSquare class="w-3.5 h-3.5" />
          <span>{{ isBatchMode ? '完成' : '批量' }}</span>
        </button>
        <button
          @click="openAddModal('new')"
          class="flex items-center gap-1.5 px-3.5 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-semibold shadow-xs transition-colors cursor-pointer"
        >
          <Plus class="w-4 h-4" />
          <span>+ 新建</span>
        </button>
      </div>
    </div>

    <!-- Filter & Search Bar -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-4 shadow-2xs space-y-3">
      <div class="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <!-- Search Input -->
        <div class="relative flex-1">
          <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="creatorSearch"
            type="text"
            placeholder="搜索创作者..."
            class="w-full pl-9 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
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
          <div class="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs text-slate-600 dark:text-slate-300">
            <ArrowUpDown class="w-3.5 h-3.5 text-slate-400" />
            <span class="text-[11px] text-slate-400 font-medium">排序</span>
            <select
              v-model="creatorSortBy"
              class="bg-transparent border-none text-xs font-medium text-slate-700 dark:text-slate-200 focus:outline-none cursor-pointer"
            >
              <option value="updated">最近活跃</option>
              <option value="posts">作品数</option>
              <option value="channels">账号数</option>
              <option value="name">按名称</option>
            </select>
          </div>
        </div>
      </div>

      <!-- Platform Filter Pills -->
      <div class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <Filter class="w-3 h-3" />
          平台筛选:
        </span>
        <button
          @click="creatorPlatformFilter = 'all'"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
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
            class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
            :class="creatorPlatformFilter === pKey
              ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
          >
            <span>{{ cfg.name }}</span>
            <span class="text-[10px] opacity-75">({{ context.creatorCountByPlatform[pKey] || 0 }})</span>
          </button>
        </template>
      </div>

      <!-- Tags Filter Row (Tri-state: Include / Exclude / Neutral) -->
      <div v-if="allTags.length > 0" class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <Tag class="w-3 h-3" />
          标签筛选:
        </span>
        <button
          type="button"
          @click="clearAllTagFilters"
          :class="includeTags.size === 0 && excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
        >
          全部标签
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
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
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

    <!-- Creator Cards Grid -->
    <div v-else class="columns-1 md:columns-2 gap-4 xl:gap-5">
      <div
        v-for="c in filteredCreatorsList"
        :key="c.id"
        class="mb-4 xl:mb-5 break-inside-avoid p-3.5 bg-white dark:bg-slate-900 rounded-2xl border transition-all duration-200 shadow-sm space-y-3 relative overflow-hidden"
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

              <!-- Subtle hover mask & camera icon -->
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
                <!-- Edit tags button -->
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
            <!-- Open Deep History Sync Modal Button -->
            <button
              @click="openDeepSyncModal(c)"
              title="回溯更早的历史动态"
              class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/60 dark:hover:bg-indigo-900/60 text-indigo-600 dark:text-indigo-400 text-xs font-semibold transition-colors cursor-pointer border border-indigo-200/60 dark:border-indigo-800/60 shadow-2xs"
            >
              <History class="w-3.5 h-3.5" />
              <span class="hidden sm:inline">回溯历史</span>
            </button>
            <!-- Quick Sync Latest -->
            <button
              @click="handleRefreshCreator(c.id)"
              title="同步最新动态"
              class="p-2 text-slate-600 hover:text-indigo-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:text-indigo-400 dark:hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
            >
              <RefreshCw class="w-4 h-4" />
            </button>
            <!-- Delete Creator Archive -->
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
              class="rounded-xl border border-slate-200/70 dark:border-slate-800/80 bg-slate-50/70 dark:bg-slate-850/50 p-2.5 space-y-1.5"
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
                    <!-- Account Role Badge with Quick Cycle Switch on Click -->
                    <button
                      @click="cycleChannelRole(ch)"
                      title="点击切换账号角色分类 (主号 / 小号 / 里号 / 自定义)"
                      class="px-1.5 py-0.5 rounded text-[10px] font-medium border transition-colors cursor-pointer shrink-0"
                      :class="getRoleBadgeClass(ch.accountRole)"
                    >
                      {{ ch.label || getRoleLabel(ch.accountRole) }}
                    </button>

                    <!-- Channel Avatar Thumbnail -->
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

                    <!-- Account Name & Link -->
                    <a
                      :href="ch.profileUrl"
                      target="_blank"
                      class="font-medium text-slate-700 dark:text-slate-200 hover:underline flex items-center gap-1 truncate max-w-[180px] sm:max-w-xs"
                      :title="ch.profileUrl"
                    >
                      <span class="truncate">{{ ch.displayName || ch.accountId }}</span>
                      <ExternalLink class="w-2.5 h-2.5 text-slate-400 shrink-0" />
                    </a>

                    <!-- Status Indicator -->
                    <span
                      v-if="ch.status === 'error'"
                      @click.stop="alert(`【${ch.displayName || ch.accountId} 同步未成功】\n\n原因：${ch.errorMessage || '未知异常'}`)"
                      class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 border border-rose-200 dark:border-rose-900/60 hover:bg-rose-100 cursor-pointer shrink-0"
                      title="点击查看具体同步错误详情"
                    >
                      同步失败
                    </span>
                  </div>

                  <!-- Actions -->
                  <div class="flex items-center gap-1 shrink-0 ml-2">
                    <!-- Deep Sync Single Channel -->
                    <button
                      @click="openDeepSyncModal(c, ch.id)"
                      title="针对该账号深度回溯更早历史动态"
                      class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <History class="w-3.5 h-3.5" />
                    </button>
                    <!-- Refresh Channel Latest (Normal click: incremental; Shift+click: force refresh existing) -->
                    <button
                      @click="handleRefreshChannel(ch, false)"
                      @click.shift.stop="handleRefreshChannel(ch, true)"
                      title="同步最新动态 (按住 Shift 点击可强制重新刷新覆盖已有内容与图片)"
                      class="p-1 text-slate-500 hover:text-indigo-600 dark:text-slate-400 dark:hover:text-indigo-400 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <RefreshCw class="w-3.5 h-3.5" :class="{ 'animate-spin': ch.status === 'updating' }" />
                    </button>
                    <!-- Delete Channel -->
                    <button
                      @click="deleteChannel(ch.id)"
                      title="移除该账号"
                      class="p-1 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-rose-50 dark:hover:bg-rose-950/40 transition-colors cursor-pointer"
                    >
                      <Trash2 class="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                <!-- Error notification if present -->
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
  </section>
</template>
