<script setup lang="ts">
import { Search, LayoutGrid, Repeat2, Image as ImageIcon, ImageOff, Tag, Users,
  ChevronDown, Eye, EyeOff, RefreshCw, CheckCircle2,
} from 'lucide-vue-next';
import PostCard from '../components/PostCard.vue';
import LoopScroll from '../components/LoopScroll.vue';
import type { PlatformMeta, Creator, Channel, Post } from '../../../src/types';
import { usePlatformDnD } from '../composables/usePlatformDnD';
import { useWaterfallFeed } from '../composables/useWaterfallFeed';

type LightboxMedia = { url: string; originalUrl?: string; type: string; title?: string } | null;

export interface FeedContext {
  searchQuery: string;
  selectedPlatform: string;
  platformOrder: string[];
  /**
   * Warm a platform's first screen of images into the disk cache (queue B5).
   * Called on sidebar hover; resolves when the pass finishes or is superseded.
   */
  prefetchPlatform: (platform: string) => Promise<void>;
  /** Platform key -> post count, for the sidebar badges. */
  platformPostCounts: Record<string, number>;
  /** Platform metadata (name/color) for the sidebar rows. */
  PLATFORM_REGISTRY: Record<string, PlatformMeta>;
  repostsCount: number;
  textOnlyCount: number;
  hideReposts: boolean;
  hideTextOnly: boolean;
  allTags: string[];
  includeTags: Set<string>;
  excludeTags: Set<string>;
  creators: Creator[];
  channels: Channel[];
  filteredPosts: Post[];
  visibleCreatorsForFilter: Creator[];
  hiddenCreatorsInFilterCount: number;
  hiddenCreatorIds: Set<string>;
  expandedCreatorIds: Set<string>;
  hiddenCreatorPlatforms: Record<string, string[]>;
  lightboxMedia: LightboxMedia;
  toggleHideReposts: () => void | Promise<void>;
  toggleHideTextOnly: () => void | Promise<void>;
  cycleTagFilter: (t: string) => void;
  clearAllTagFilters: () => void;
  getTagFilterState: (t: string) => 'include' | 'exclude' | 'none';
  loadDemoData: () => void | Promise<void>;
  openAddModal: (mode: 'new' | 'channel', creator?: Creator | null, initialUrl?: string) => void;
  toggleBookmarkPost: (post: Post) => void | Promise<void>;
  handleDeletePost: (post: Post) => void | Promise<void>;
  markPostRead: (post: Post) => void | Promise<void>;
  handleAvatarError: (url?: string) => void;
  unhideAllCreators: () => void;
  toggleExpandCreator: (creatorId: string) => void;
  toggleHideCreator: (creatorId: string) => void;
  toggleHideCreatorPlatform: (creatorId: string, platformKey: string) => void;
  resetCreatorHiddenPlatforms: (creatorId: string) => void;
  getCreatorAvatar: (c?: Creator | null) => string;
  getCreatorPlatforms: (creatorId: string) => string[];
  /** 打开全宽阅读视图（长文 / RSS 全文）。 */
  onOpenReader: (post: Post) => void;
}

const props = defineProps<{ context: FeedContext }>();
const emit = defineEmits<{
  'update:searchQuery': [value: string];
  'update:selectedPlatform': [value: string];
  'reorder-platforms': [order: string[]];
  'update:lightboxMedia': [media: { url: string; originalUrl?: string; type: string; title?: string } | null];
}>();

// ===== Sidebar platform list: custom order + drag & drop =====
const {
  orderedPlatformKeys,
  dragPlatformKey,
  dragOverPlatformKey,
  onPlatformDragStart,
  onPlatformDragOver,
  onPlatformDrop,
} = usePlatformDnD({
  platformOrder: () => props.context.platformOrder,
  registryKeys: () => Object.keys(props.context.PLATFORM_REGISTRY),
  onReorder: (order) => emit('reorder-platforms', order),
});

// ===== Pagination, infinite scroll and the responsive masonry =====
const { visibleCount, infiniteScrollTrigger, feedColumns } = useWaterfallFeed({
  posts: () => props.context.filteredPosts,
});

function handleSearchInput(event: Event) {

  emit('update:searchQuery', (event.target as HTMLInputElement).value);
}

</script>

<template>
<section class="flex flex-col lg:flex-row items-start gap-4 xl:gap-5">

  <!-- 1. LEFT SIDEBAR: Platform, Tags & Filters Navigation -->
  <aside class="w-full lg:w-48 xl:w-52 shrink-0 space-y-3.5 lg:sticky lg:top-20">
    <!-- Search input -->
    <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs">
      <div class="relative">
        <Search class="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-400" />
        <input
          :value="context.searchQuery"
          @input="handleSearchInput"
          type="text"
          placeholder="搜索内容或创作者…"
          class="w-full pl-8 pr-3 py-1.5 bg-slate-100 dark:bg-slate-800/90 border border-slate-200 dark:border-slate-700/80 rounded-xl text-xs outline-none focus:ring-1 focus:ring-indigo-500 text-slate-800 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500"
        />
      </div>
    </div>

    <!-- Platform Navigation Menu -->
    <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-1">
      <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1 flex items-center justify-between">
        <span>平台</span>
        <span class="text-[10px] font-mono font-normal text-slate-400 dark:text-slate-500">{{ Object.keys(context.PLATFORM_REGISTRY).length }} 个平台</span>
      </div>

      <!-- The list is capped and scrolls; it deliberately does NOT loop. The
           left column feeds the tag filter below it, and an uncapped list grew
           without bound as platforms were added, pushing that section down. -->
      <!-- Resizable on the same terms as the creator list below: same grip, same
           Arrow/Home/End keys, same persisted row count — a control that appears in
           one sidebar and not the other reads as an omission rather than a decision. -->
      <LoopScroll
        :loop="false"
        :item-count="orderedPlatformKeys.length + 1"
        :rows="6"
        :min-rows="4"
        :max-rows="8"
        storage-key="cfh_feed_platform_list_rows"
        :cap-to-viewport="350"
        resizable
        aria-label="平台列表"
      >
      <!-- All Platforms Button -->
      <button
        @click="emit('update:selectedPlatform', 'all')"
        :class="context.selectedPlatform === 'all' ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 font-bold border-indigo-200 dark:border-indigo-500/40 shadow-2xs' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 dark:hover:text-white border-transparent'"
        class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border transition-all cursor-pointer"
      >
        <div class="flex items-center gap-2">
          <LayoutGrid class="w-4 h-4" />
          <span>全部</span>
        </div>
        <span class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-transparent dark:border-slate-700/60">
          {{ context.platformPostCounts['all'] || 0 }}
        </span>
      </button>

      <!-- Each Platform Button (draggable: drag to customize sidebar order) -->
      <button
        v-for="key in orderedPlatformKeys"
        :key="key"
        draggable="true"
        @click="emit('update:selectedPlatform', key)"
        @mouseenter="context.prefetchPlatform(key)"
        @dragstart="onPlatformDragStart(key)"
        @dragover="(e: DragEvent) => onPlatformDragOver(e, key)"
        @dragleave="dragOverPlatformKey = null"
        @drop="onPlatformDrop(key)"
        @dragend="dragPlatformKey = null; dragOverPlatformKey = null"
        :class="[
          context.selectedPlatform === key ? 'bg-indigo-50 text-indigo-700 dark:bg-indigo-500/15 dark:text-indigo-300 font-bold border-indigo-200 dark:border-indigo-500/40 shadow-2xs' : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/80 dark:hover:text-white border-transparent',
          dragOverPlatformKey === key ? 'ring-2 ring-indigo-400 border-dashed' : '',
        ]"
        class="w-full flex items-center justify-between px-3 py-2 text-xs rounded-xl border transition-all cursor-grab active:cursor-grabbing"
        :title="'筛选该平台 · 拖拽调整侧栏顺序'"
      >
        <div class="flex items-center gap-2 truncate">
          <span class="w-2.5 h-2.5 rounded-full shrink-0" :style="{ backgroundColor: context.PLATFORM_REGISTRY[key].color }"></span>
          <span class="truncate">{{ context.PLATFORM_REGISTRY[key].name }}</span>
        </div>
        <span
          v-if="context.platformPostCounts[key]"
          class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-transparent dark:border-slate-700/60"
        >
          {{ context.platformPostCounts[key] }}
        </span>
      </button>
      </LoopScroll>
    </div>

    <!-- Content Preferences & Tag Filter -->
    <div class="p-3 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-3">
      <!-- Content Preferences Buttons -->
      <div class="space-y-1.5">
        <!-- Repost Toggle Button -->
        <button
          @click="context.toggleHideReposts"
          class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer border"
          :class="context.hideReposts ? 'bg-amber-50 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/40 font-semibold shadow-2xs' : 'bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white'"
          :title="context.hideReposts ? '当前仅显示原创；点按恢复显示转发' : '只看创作者原创（过滤转发/转推）'"
        >
          <div class="flex items-center gap-2">
            <Repeat2 class="w-3.5 h-3.5" :class="{ 'text-amber-600 dark:text-amber-400': context.hideReposts }" />
            <span>{{ context.hideReposts ? '仅原创' : '含转发' }}</span>
          </div>
          <span
            v-if="context.repostsCount > 0"
            class="text-[10px] px-1.5 py-0.2 rounded-full font-mono"
            :class="context.hideReposts ? 'bg-amber-200/80 dark:bg-amber-500/25 text-amber-800 dark:text-amber-200' : 'bg-slate-200 dark:bg-slate-700/80 text-slate-500 dark:text-slate-400'"
          >
            {{ context.repostsCount }}
          </span>
        </button>

        <!-- Text-only Post Filter Toggle Button -->
        <button
          @click="context.toggleHideTextOnly"
          class="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer border"
          :class="context.hideTextOnly ? 'bg-indigo-50 text-indigo-800 border-indigo-300 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/40 font-semibold shadow-2xs' : 'bg-slate-50 dark:bg-slate-800/50 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700/60 hover:bg-slate-100 dark:hover:bg-slate-800 dark:hover:text-white'"
          :title="context.hideTextOnly ? '当前已过滤纯文字动态；点按恢复显示' : '只看含图片/视频的动态（过滤纯文字）'"
        >
          <div class="flex items-center gap-2">
            <ImageIcon v-if="context.hideTextOnly" class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
            <ImageOff v-else class="w-3.5 h-3.5 text-slate-400" />
            <span>{{ context.hideTextOnly ? '仅图文' : '含纯文字' }}</span>
          </div>
          <span
            v-if="context.textOnlyCount > 0"
            class="text-[10px] px-1.5 py-0.2 rounded-full font-mono"
            :class="context.hideTextOnly ? 'bg-indigo-200/80 dark:bg-indigo-500/25 text-indigo-800 dark:text-indigo-200' : 'bg-slate-200 dark:bg-slate-700/80 text-slate-500 dark:text-slate-400'"
          >
            {{ context.textOnlyCount }}
          </span>
        </button>
      </div>

      <!-- Tags Filter (Tri-state: Include / Exclude / Neutral) -->
      <div v-if="context.allTags.length > 0">
        <div class="text-[11px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1 flex items-center justify-between">
          <div class="flex items-center gap-1">
            <Tag class="w-3 h-3" />
            <span>标签</span>
          </div>
          <button
            v-if="context.includeTags.size > 0 || context.excludeTags.size > 0"
            type="button"
            @click="context.clearAllTagFilters"
            class="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer lowercase"
          >
            清除
          </button>
        </div>
        <p class="text-[10px] text-slate-400 dark:text-slate-500 px-2 pb-1">
          点击循环：包含 → 排除 → 全部
        </p>
        <div class="flex flex-wrap gap-1.5 pt-1 px-1">
          <button
            type="button"
            @click="context.clearAllTagFilters"
            :class="context.includeTags.size === 0 && context.excludeTags.size === 0 ? 'bg-indigo-600 text-white font-semibold shadow-2xs' : 'bg-slate-100 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-slate-700/60 hover:bg-slate-200 dark:hover:bg-slate-700 dark:hover:text-white'"
            class="px-2.5 py-1 text-[11px] rounded-lg transition-colors cursor-pointer"
          >
            全部
          </button>
          <button
            v-for="t in context.allTags"
            :key="t"
            type="button"
            @click="context.cycleTagFilter(t)"
            :class="[
              context.getTagFilterState(t) === 'include'
                ? 'bg-indigo-600 text-white font-bold shadow-2xs'
                : context.getTagFilterState(t) === 'exclude'
                ? 'bg-rose-600 text-white font-bold shadow-2xs line-through'
                : 'bg-slate-100 dark:bg-slate-800/70 text-slate-600 dark:text-slate-300 border border-slate-200/60 dark:border-slate-700/60 hover:bg-slate-200 dark:hover:bg-slate-700 dark:hover:text-white'
            ]"
            class="px-2.5 py-1 text-[11px] rounded-lg transition-all cursor-pointer flex items-center gap-1"
            :title="context.getTagFilterState(t) === 'include' ? '当前：正向包含；再点切为反向排除' : context.getTagFilterState(t) === 'exclude' ? '当前：反向排除；再点取消筛选' : '设为正向包含（+）'"
          >
            <span v-if="context.getTagFilterState(t) === 'include'" class="text-[10px] font-black">+</span>
            <span v-else-if="context.getTagFilterState(t) === 'exclude'" class="text-[10px] font-black">−</span>
            <span>#{{ t }}</span>
          </button>
        </div>
      </div>
    </div>
  </aside>

  <!-- 2. CENTER MAIN CONTENT: Feed Posts Stream -->
  <div class="flex-1 min-w-0 w-full space-y-4">

    <!-- Empty State -->
    <div v-if="context.filteredPosts.length === 0" class="text-center py-20 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
      <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-indigo-50 dark:bg-indigo-950/50 flex items-center justify-center text-indigo-500">
        <LayoutGrid class="w-8 h-8" />
      </div>
      <h3 class="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">暂无匹配动态</h3>
      <p class="text-xs text-slate-500 max-w-md mx-auto mb-5 leading-relaxed">
        {{ context.creators.length === 0 ? '还没有关注任何创作者。试试浏览创作者主页时点击右上角扩展图标快速关注，或导入演示数据体验。' : '当前筛选下没有匹配的内容，试试同步最新动态或调整筛选。' }}
      </p>
      <div class="flex justify-center gap-3">
        <button
          v-if="context.creators.length === 0"
          @click="context.loadDemoData"
          class="px-4 py-2 text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300 rounded-xl transition-colors cursor-pointer"
        >
          导入演示数据
        </button>
        <button
          @click="context.openAddModal('new')"
          class="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer"
        >
          关注第一位创作者
        </button>
      </div>
    </div>

    <!-- Multi-Platform Responsive Masonry Waterfall Layout -->
    <div v-else class="space-y-6">
    <div class="flex gap-4 xl:gap-5 items-start">
      <div
        v-for="(colPosts, colIdx) in feedColumns"
        :key="'feed-col-' + colIdx"
        class="flex-1 flex flex-col gap-4 xl:gap-5 min-w-0"
      >
        <PostCard
          v-for="post in colPosts"
          :key="post.id"
          :post="post"
          :creators="context.creators"
          :channels="context.channels"
          :bookmarked="Boolean(post.isBookmarked)"
          auto-read
          @bookmark="context.toggleBookmarkPost"
          @delete="context.handleDeletePost"
          @read="context.markPostRead"
          @media="emit('update:lightboxMedia', $event)"
          @avatar-error="context.handleAvatarError"
          @open-reader="context.onOpenReader"
        />
      </div>
    </div>

    <!-- Infinite Scroll Sentinel & Pagination Indicator -->
    <div ref="infiniteScrollTrigger" class="py-8 flex flex-col items-center justify-center text-xs text-slate-400">
      <div v-if="context.filteredPosts.length > visibleCount" class="flex items-center gap-2 text-indigo-600 dark:text-indigo-400 font-medium bg-indigo-50/70 dark:bg-indigo-950/40 px-4 py-2 rounded-full border border-indigo-100 dark:border-indigo-900/60 shadow-2xs">
        <RefreshCw class="w-3.5 h-3.5 animate-spin" />
        <span>加载更多 · 已显示 {{ visibleCount }} / {{ context.filteredPosts.length }}</span>
      </div>
      <div v-else-if="context.filteredPosts.length > 0" class="flex items-center gap-2 text-slate-400 dark:text-slate-500 py-2">
        <CheckCircle2 class="w-3.5 h-3.5 text-emerald-500" />
        <span>已显示全部 {{ context.filteredPosts.length }} 条动态</span>
      </div>
    </div>
  </div>
  </div>

  <!-- 3. RIGHT SIDEBAR: Creator Selection & Direct Platform Filtering ("成套的右侧边栏") -->
  <aside class="w-full lg:w-64 xl:w-68 shrink-0 space-y-3.5 lg:sticky lg:top-20">
    <div class="p-3.5 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 shadow-2xs space-y-3">
      <!-- Sidebar Header -->
      <div class="flex items-center justify-between px-1">
        <div class="flex items-center gap-2">
          <Users class="w-4 h-4 text-indigo-500" />
          <span class="text-xs font-bold text-slate-800 dark:text-slate-200">
            {{ context.selectedPlatform === 'all' ? '创作者' : `${context.PLATFORM_REGISTRY[context.selectedPlatform]?.name || context.selectedPlatform} 创作者` }}
          </span>
          <span class="text-[10px] px-1.5 py-0.2 rounded-full font-mono bg-slate-100 dark:bg-slate-800 text-slate-500">
            {{ context.visibleCreatorsForFilter.length }}
          </span>
        </div>
        <div v-if="context.hiddenCreatorsInFilterCount > 0" class="flex items-center gap-1.5">
          <span class="text-[10px] text-amber-600 dark:text-amber-400 font-medium">
            已隐 {{ context.hiddenCreatorsInFilterCount }} 位创作者
          </span>
          <button
            type="button"
            @click="context.unhideAllCreators"
            class="text-[10px] text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-medium"
          >
            全部显示
          </button>
        </div>
      </div>

      <!-- Hint text -->
      <div class="text-[11px] text-slate-400 px-1 leading-snug">
        点击卡片展开渠道，点击 👁 隐藏该作者
      </div>

      <!-- Empty Creators under filter -->
      <div
        v-if="context.visibleCreatorsForFilter.length === 0"
        class="text-center py-6 text-xs text-slate-400 bg-slate-50/50 dark:bg-slate-800/30 rounded-xl border border-dashed border-slate-200 dark:border-slate-800"
      >
        当前暂无匹配创作者
      </div>

      <!-- Creator Cards List: rows loop seamlessly and the height is draggable:
           the list used to be a plain capped scroller that simply ended, and its
           height was fixed at `100vh - 210px` with no way to change it. -->
      <LoopScroll
        v-else
        :item-count="context.visibleCreatorsForFilter.length"
        storage-key="cfh_feed_creator_list_rows"
        :min-rows="4"
        :max-rows="8"
        :cap-to-viewport="210"
        resizable
        aria-label="创作者列表"
      >
        <div
          v-for="c in context.visibleCreatorsForFilter"
          :key="c.id"
          class="rounded-xl border transition-all select-none overflow-hidden"
          :class="[
            context.hiddenCreatorIds.has(c.id)
              ? 'bg-slate-100/60 dark:bg-slate-900/40 border-slate-200 dark:border-slate-800/60 opacity-50'
              : 'bg-slate-50/70 dark:bg-slate-800/60 border-slate-200/80 dark:border-slate-700/60 shadow-2xs hover:border-indigo-300 dark:hover:border-indigo-500/50 dark:hover:bg-slate-800/80'
          ]"
        >
          <!-- Creator Card Header (Click to expand/fold inline directly) -->
          <div
            @click="context.toggleExpandCreator(c.id)"
            class="flex items-center justify-between p-2.5 cursor-pointer hover:bg-slate-100/60 dark:hover:bg-slate-700/40 transition-colors gap-2"
            :title="context.hiddenCreatorIds.has(c.id) ? '展开或收起该创作者的渠道' : '展开或收起该创作者的渠道'"
          >
            <!-- Left: Avatar & Name -->
            <div class="flex items-center gap-2.5 min-w-0">
              <div class="w-8 h-8 rounded-full overflow-hidden shrink-0 border border-slate-200/80 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-500">
                <img
                  v-if="context.getCreatorAvatar(c)"
                  :src="context.getCreatorAvatar(c)"
                  referrerpolicy="no-referrer"
                  class="w-full h-full object-cover"
                  @error="context.handleAvatarError(context.getCreatorAvatar(c))"
                />
                <span v-else>{{ (c.name || 'C').slice(0, 1) }}</span>
              </div>

              <div class="min-w-0">
                <div
                  class="text-xs font-bold text-slate-800 dark:text-slate-200 truncate max-w-[130px]"
                  :class="{ 'line-through text-slate-400': context.hiddenCreatorIds.has(c.id) }"
                  :title="c.name"
                >
                  {{ c.name }}
                </div>
                <div class="flex items-center gap-1.5 text-[10px] text-slate-400 mt-0.5">
                  <span>{{ context.getCreatorPlatforms(c.id).length }} 个平台</span>
                  <span
                    v-if="context.selectedPlatform === 'all' && context.hiddenCreatorPlatforms[c.id]?.length"
                    class="px-1.5 py-0.2 rounded-full bg-rose-50 dark:bg-rose-950/60 text-rose-600 dark:text-rose-400 font-medium text-[9px] border border-rose-200/60 dark:border-rose-900/60"
                  >
                    已隐 {{ context.hiddenCreatorPlatforms[c.id].length }} 个渠道
                  </span>
                </div>
              </div>
            </div>

            <!-- Right: Eye Toggle Button + Chevron Indicator -->
            <div class="flex items-center gap-1 shrink-0">
              <button
                type="button"
                @click.stop="context.toggleHideCreator(c.id)"
                class="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 transition-colors cursor-pointer"
                :title="context.hiddenCreatorIds.has(c.id) ? '恢复显示该创作者' : '隐藏该创作者的所有动态'"
              >
                <EyeOff v-if="context.hiddenCreatorIds.has(c.id)" class="w-3.5 h-3.5 text-rose-500" />
                <Eye v-else class="w-3.5 h-3.5 text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400" />
              </button>
              <div
                class="p-0.5 text-slate-400 transition-transform duration-200"
                :class="{ 'rotate-180': context.expandedCreatorIds.has(c.id) }"
              >
                <ChevronDown class="w-3.5 h-3.5" />
              </div>
            </div>
          </div>

          <!-- INLINE EXPANSION: 直接展开选择渠道 (点开直接选择，非二级菜单弹窗) -->
          <div
            v-if="context.expandedCreatorIds.has(c.id)"
            class="p-2.5 pt-2 bg-slate-100/70 dark:bg-slate-900/90 border-t border-slate-200/60 dark:border-slate-700/60 space-y-2 text-xs animate-in fade-in duration-150"
          >
            <div class="flex items-center justify-between text-[10px] text-slate-400 px-0.5">
              <span>显示的平台渠道：</span>
              <button
                v-if="context.hiddenCreatorPlatforms[c.id]?.length"
                type="button"
                @click.stop="context.resetCreatorHiddenPlatforms(c.id)"
                class="text-indigo-600 dark:text-indigo-400 hover:underline cursor-pointer font-medium"
              >
                全部显示
              </button>
            </div>

            <!-- Platform items of this creator -->
            <div v-if="context.getCreatorPlatforms(c.id).length === 0" class="text-center py-2 text-[11px] text-slate-400">
              暂无绑定账号
            </div>
            <div v-else class="space-y-1.5">
              <div
                v-for="pKey in context.getCreatorPlatforms(c.id)"
                :key="pKey"
                @click.stop="context.toggleHideCreatorPlatform(c.id, pKey)"
                class="flex items-center justify-between px-2.5 py-1.5 rounded-lg border transition-all cursor-pointer"
                :class="context.hiddenCreatorPlatforms[c.id]?.includes(pKey)
                  ? 'bg-rose-50/80 dark:bg-rose-950/40 border-rose-200 dark:border-rose-900/50 text-rose-700 dark:text-rose-300'
                  : 'bg-white dark:bg-slate-800/90 border-slate-200/80 dark:border-slate-700/70 text-slate-700 dark:text-slate-200 hover:border-indigo-300 dark:hover:border-indigo-500/40'"
              >
                <div class="flex items-center gap-2 truncate min-w-0">
                  <span
                    class="w-2.5 h-2.5 rounded-full shrink-0"
                    :style="{ backgroundColor: context.PLATFORM_REGISTRY[pKey]?.color || '#6366f1' }"
                  ></span>
                  <div class="min-w-0 truncate">
                    <span class="font-semibold text-[11px] truncate">
                      {{ context.PLATFORM_REGISTRY[pKey]?.name || pKey }}
                    </span>
                    <span class="text-[9px] text-slate-400 ml-1 truncate">
                      {{ context.channels.filter(ch => ch.creatorId === c.id && ch.platform === pKey).map(ch => ch.displayName || ch.label || ch.accountId).join(', ') }}
                    </span>
                  </div>
                </div>

                <!-- Direct status toggle pill -->
                <div class="flex items-center gap-1 shrink-0 text-[10px] font-medium ml-2">
                  <span v-if="context.hiddenCreatorPlatforms[c.id]?.includes(pKey)" class="flex items-center gap-0.5 text-rose-600 dark:text-rose-400 px-1.5 py-0.5 rounded-md bg-rose-100/70 dark:bg-rose-950/80 border border-rose-200 dark:border-rose-800">
                    <EyeOff class="w-3 h-3" />
                    <span>已隐藏</span>
                  </span>
                  <span v-else class="flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400 px-1.5 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800">
                    <Eye class="w-3 h-3" />
                    <span>显示中</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </LoopScroll>
    </div>
  </aside>
</section>


</template>
