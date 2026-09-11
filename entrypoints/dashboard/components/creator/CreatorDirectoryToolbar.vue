<script lang="ts">
/**
 * 目录工具条的上下文契约（由 `CreatorsView` 构建并传入）。
 *
 * 一条规则：**工具条不持有状态**。所有值都由视图传入、所有改动都通过回调上抛，
 * 这样筛选状态只有一份（`useCreatorDirectoryFilters`），工具条与三套视图不会各记一份。
 */
export interface CreatorDirectoryToolbarContext {
  /** 搜索关键字（创作者名 / 标签 / 账号名与 ID）。 */
  search: string;
  /** 平台筛选：'all' 或 platform key。 */
  platformFilter: string;
  /** 账号类型筛选：'all' 或 AccountRole。 */
  roleFilter: 'all' | string;
  /** 当前排序键与方向（排序控件只改键，方向由「首次点击取自然方向」的规则决定）。 */
  sortBy: 'updated' | 'posts' | 'channels' | 'name' | 'tags' | 'platform' | 'manual';
  /** 排序下拉的选项表（由 composable 提供，避免两处各写一份）。 */
  sortOptions: { value: string; label: string }[];

  /** 视图模式（网格 / 紧凑列表 / 详细卡片）。 */
  viewMode: 'grid' | 'list' | 'detailed';
  /** 标签抽屉是否展开（纯 UI 状态，仍由视图持有）。 */
  tagsExpanded: boolean;
  /** 批量模式与当前选中数。 */
  isBatchMode: boolean;
  selectedCount: number;

  /** 全部标签与三态标签筛选状态。 */
  allTags: string[];
  includeTags: Set<string>;
  excludeTags: Set<string>;

  /** 各类计数（角标与空态文案）。 */
  creatorCountByPlatform: Record<string, number>;
  creatorCountByRole: Record<string, number>;
  filteredCount: number;
  totalCount: number;

  /** 值变更回调。 */
  onSearch: (value: string) => void;
  onPlatform: (value: string) => void;
  onRole: (value: string) => void;
  onSort: (key: string) => void;
  onViewMode: (mode: 'grid' | 'list' | 'detailed') => void;
  onToggleTagsExpanded: () => void;
  onCycleTag: (tag: string) => void;
  onClearTagFilters: () => void;
  onToggleBatchMode: () => void;

  /** 动作回调（批量与其他视图动作，全部由视图上抛父级）。 */
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBatchRefresh: () => void;
  onBatchDelete: () => void;
  onAdd: () => void;

  /** 三态标签芯片的当前状态查询。 */
  getTagFilterState: (tag: string) => 'include' | 'exclude' | 'none';
}
</script>

<script setup lang="ts">
import { computed } from 'vue';
import {
  PLATFORM_REGISTRY,
  ACCOUNT_ROLE_ORDER,
  ACCOUNT_ROLE_SHORT_LABELS,
} from '../../../../src/types';
import {
  Plus,
  CheckSquare,
  Search,
  X,
  ArrowUpDown,
  Filter,
  Tag,
  ChevronDown,
  LayoutGrid,
  List,
  LayoutList,
  RefreshCw,
  Trash2,
  UserRound,
} from 'lucide-vue-next';
import AppSelect from '../AppSelect.vue';

const props = defineProps<{ context: CreatorDirectoryToolbarContext }>();

// 与视图一致的浅只读包装：模板里统一写 `context.xxx`。
const context = computed(() => props.context);
</script>

<template>
  <!-- THREE root nodes on purpose: `<section class="space-y-4">` in the view
       spaces its direct children, so wrapping these blocks in an extra element
       would collapse the header→filter bar gap. A fragment keeps every sibling
       relation (and therefore the rendered markup) exactly as it was. -->
  <!-- Header & Action Toolbar (single compact row) -->
  <div class="flex flex-wrap items-center justify-between gap-2.5">
    <div class="flex items-center gap-2 flex-wrap">
      <h2 class="font-bold text-lg text-slate-900 dark:text-white">关注管理</h2>
      <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-900">
        {{ context.filteredCount }} / {{ context.totalCount }} 位创作者
      </span>
    </div>

    <!-- Right Action Group: View Mode Switcher + Batch Mode + Add Button -->
    <div class="flex items-center gap-2 flex-wrap">
      <!-- View Mode Switcher -->
      <div class="flex items-center p-0.5 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200/80 dark:border-slate-700/80 shadow-2xs">
        <button
          type="button"
          @click="context.onViewMode('grid')"
          :class="context.viewMode === 'grid' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
          title="网格磁贴视图（中等密度，清晰直观）"
        >
          <LayoutGrid class="w-3.5 h-3.5" />
          <span class="hidden md:inline">网格</span>
        </button>
        <button
          type="button"
          @click="context.onViewMode('list')"
          :class="context.viewMode === 'list' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
          title="紧凑列表视图（超高密度，一屏容纳 20+ 位创作者）"
        >
          <List class="w-3.5 h-3.5" />
          <span class="hidden md:inline">紧凑列表</span>
        </button>
        <button
          type="button"
          @click="context.onViewMode('detailed')"
          :class="context.viewMode === 'detailed' ? 'bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-300 shadow-xs font-semibold' : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs transition-all cursor-pointer"
          title="详细卡片视图（展开全部账号与角色管理）"
        >
          <LayoutList class="w-3.5 h-3.5" />
          <span class="hidden md:inline">详细卡片</span>
        </button>
      </div>

      <button
        @click="context.onToggleBatchMode()"
        :class="context.isBatchMode ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'"
        class="flex items-center gap-1.5 px-3 py-1.5 border rounded-xl text-xs font-semibold shadow-2xs transition-colors cursor-pointer"
      >
        <CheckSquare class="w-3.5 h-3.5" />
        <span>{{ context.isBatchMode ? '完成批量' : '批量操作' }}</span>
      </button>

      <button
        @click="context.onAdd()"
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
          :value="context.search"
          @input="context.onSearch(($event.target as HTMLInputElement).value)"
          type="text"
          placeholder="快速搜索创作者名称、标签或账号…"
          class="w-full pl-8 pr-8 py-1.5 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
        />
        <button
          v-if="context.search"
          @click="context.onSearch('')"
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
            :model-value="context.sortBy"
            :options="context.sortOptions"
            aria-label="创作者排序方式"
            button-class="py-1.5 pr-2 pl-0.5 text-xs bg-transparent dark:bg-transparent border-none hover:border-transparent dark:hover:border-transparent"
            @update:model-value="(v) => context.onSort(String(v))"
          />
        </div>

        <!-- Tags Drawer Trigger Button if tags exist -->
        <button
          v-if="context.allTags.length > 0"
          type="button"
          @click="context.onToggleTagsExpanded()"
          :class="context.tagsExpanded || context.includeTags.size > 0 || context.excludeTags.size > 0 ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-300 border-indigo-200 dark:border-indigo-800' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-transparent'"
          class="flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-medium border transition-colors cursor-pointer"
          title="展开/收起标签过滤"
        >
          <Tag class="w-3.5 h-3.5" />
          <span>标签</span>
          <span v-if="context.includeTags.size > 0 || context.excludeTags.size > 0" class="w-2 h-2 rounded-full bg-indigo-500"></span>
          <ChevronDown class="w-3 h-3 transition-transform duration-200" :class="{ 'rotate-180': context.tagsExpanded }" />
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
        @click="context.onPlatform('all')"
        class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
        :class="context.platformFilter === 'all'
          ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
      >
        全部 ({{ context.totalCount }})
      </button>
      <template v-for="(cfg, pKey) in PLATFORM_REGISTRY" :key="pKey">
        <button
          v-if="context.creatorCountByPlatform[pKey]"
          @click="context.onPlatform(pKey)"
          class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
          :class="context.platformFilter === pKey
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
        @click="context.onRole('all')"
        class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
        :class="context.roleFilter === 'all'
          ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
      >
        全部 ({{ context.totalCount }})
      </button>
      <button
        v-for="role in ACCOUNT_ROLE_ORDER"
        :key="'role-' + role"
        @click="context.onRole(role)"
        class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
        :class="context.roleFilter === role
          ? 'bg-indigo-600 text-white shadow-2xs font-semibold'
          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
      >
        <span>{{ ACCOUNT_ROLE_SHORT_LABELS[role] }}</span>
        <span class="text-[10px] opacity-75">({{ context.creatorCountByRole[role] || 0 }})</span>
      </button>
    </div>

    <!-- Collapsible Tags Filter Row -->
    <div v-if="context.allTags.length > 0 && context.tagsExpanded" class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs animate-fade-in">
      <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
        <Tag class="w-3 h-3" />
        标签筛选:
      </span>
      <button
        type="button"
        @click="context.onClearTagFilters()"
        :class="context.includeTags.size === 0 && context.excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'"
        class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer"
      >
        全部
      </button>
      <button
        v-for="t in context.allTags"
        :key="'dir-tag-' + t"
        type="button"
        @click="context.onCycleTag(t)"
        :class="[
          context.getTagFilterState(t) === 'include'
            ? 'bg-indigo-600 text-white font-bold shadow-2xs'
            : context.getTagFilterState(t) === 'exclude'
            ? 'bg-rose-600 text-white font-bold shadow-2xs line-through'
            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700'
        ]"
        class="px-2 py-0.5 rounded-md text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
        :title="context.getTagFilterState(t) === 'include' ? '正向包含（点击切为反向排除）' : context.getTagFilterState(t) === 'exclude' ? '反向排除（点击取消）' : '点击设置为正向包含(+)'"
      >
        <span v-if="context.getTagFilterState(t) === 'include'" class="text-[10px] font-black">+</span>
        <span v-else-if="context.getTagFilterState(t) === 'exclude'" class="text-[10px] font-black">−</span>
        <span>#{{ t }}</span>
      </button>
    </div>
  </div>

  <!-- Batch Action Toolbar (When Batch Mode Active) -->
  <div
    v-if="context.isBatchMode"
    class="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-indigo-50/90 dark:bg-indigo-950/50 border border-indigo-200 dark:border-indigo-800/70 rounded-2xl animate-fade-in"
  >
    <div class="flex items-center gap-3">
      <button
        @click="context.onSelectAll()"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-white dark:bg-slate-900 border border-indigo-200 dark:border-indigo-800 rounded-lg text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-indigo-50 cursor-pointer"
      >
        <CheckSquare class="w-3.5 h-3.5 text-indigo-600" />
        <span>全选 ({{ context.filteredCount }})</span>
      </button>
      <button
        @click="context.onClearSelection()"
        class="text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 underline cursor-pointer"
      >
        清空选择
      </button>
      <span class="text-xs font-semibold text-indigo-700 dark:text-indigo-300">
        已选 {{ context.selectedCount }} 位
      </span>
    </div>

    <div class="flex items-center gap-2">
      <button
        @click="context.onBatchRefresh()"
        :disabled="context.selectedCount === 0"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
      >
        <RefreshCw class="w-3.5 h-3.5" />
        <span>同步选中</span>
      </button>
      <button
        @click="context.onBatchDelete()"
        :disabled="context.selectedCount === 0"
        class="flex items-center gap-1.5 px-3 py-1.5 bg-rose-600 hover:bg-rose-700 text-white rounded-lg text-xs font-semibold disabled:opacity-40 transition-colors cursor-pointer shadow-2xs"
      >
        <Trash2 class="w-3.5 h-3.5" />
        <span>删除选中</span>
      </button>
    </div>
  </div>
</template>
