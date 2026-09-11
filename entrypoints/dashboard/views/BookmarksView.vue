<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Bookmark, Filter, Search, X, UserRound } from 'lucide-vue-next';
import { PLATFORM_REGISTRY, ACCOUNT_ROLE_LABELS, ACCOUNT_ROLE_ORDER, type Channel, type Creator, type Post } from '../../../src/types';
import PostCard from '../components/PostCard.vue';

export interface MediaPayload {
  url: string;
  originalUrl?: string;
  type: string;
  title?: string;
}

export interface BookmarksViewContext {
  posts: Post[];
  creators: Creator[];
  channels: Channel[];
  /** Global "hide text-only posts" preference — applied to the bookmarks list too. */
  hideTextOnly: boolean;
  onGoToFeed: () => void;
  onToggleBookmark: (post: Post) => void | Promise<void>;
  onDelete: (post: Post) => void | Promise<void>;
  onRead: (post: Post) => void | Promise<void>;
  onOpenMedia: (media: MediaPayload) => void;
  onAvatarError: (url?: string) => void;
  /** 打开全宽阅读视图（长文 / RSS 全文）。 */
  onOpenReader: (post: Post) => void;
}

const props = withDefaults(
  defineProps<{ active?: boolean; context: BookmarksViewContext }>(),
  { active: true }
);

// Local UI controls (view-owned)
const bookmarkSearchQuery = ref('');
const bookmarkSelectedPlatform = ref<string>('all');
/** 账号角色过滤：'all' | 'main' | 'sub' | 'alt' | 'custom'。 */
const bookmarkSelectedRole = ref<string>('all');

/** Roles actually present among bookmarked posts' source channels. */
const bookmarkRoles = computed(() => {
  const present = new Set<string>();
  for (const p of props.context.posts) {
    if (!p.isBookmarked) continue;
    const ch = props.context.channels.find(c => c.id === p.channelId);
    if (ch) present.add(ch.accountRole || 'main');
  }
  return ACCOUNT_ROLE_ORDER.filter(r => present.has(r)).map(key => ({ key, label: ACCOUNT_ROLE_LABELS[key] }));
});
function isTextOnlyPost(p: Post): boolean {
  return !p.mediaList || p.mediaList.length === 0;
}

// Filtered Bookmarked Posts — mirrors the App-level computed over raw posts
const filteredBookmarkedPosts = computed(() => {
  return props.context.posts.filter(p => {
    if (!p.isBookmarked) return false;
    // Platform filter
    if (bookmarkSelectedPlatform.value !== 'all' && p.platform !== bookmarkSelectedPlatform.value) {
      return false;
    }
    // Account role filter: keep posts whose source channel carries the role.
    if (bookmarkSelectedRole.value !== 'all') {
      const ch = props.context.channels.find(c => c.id === p.channelId);
      if (!ch || (ch.accountRole || 'main') !== bookmarkSelectedRole.value) return false;
    }
    // Text-only filter (hide posts without media)
    if (props.context.hideTextOnly && isTextOnlyPost(p)) {
      return false;
    }
    // Search query: text/author/#tag (tag word matches the creator's tags)
    if (bookmarkSearchQuery.value.trim()) {
      const raw = bookmarkSearchQuery.value.trim().toLowerCase();
      const q = raw.startsWith('#') ? raw.slice(1) : raw;
      const matchText = (p.title || '').toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
      const creator = props.context.creators.find(c => c.id === p.creatorId);
      const matchAuthor = creator?.name.toLowerCase().includes(q);
      const matchTag = Boolean(q) && (creator?.tags || []).some(t => t.toLowerCase().includes(q));
      if (!matchText && !matchAuthor && !matchTag) return false;
    }
    return true;
  });
});

// Masonry waterfall: responsive column count from viewport width
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200);
const columnCount = computed(() => {
  if (windowWidth.value < 768) return 1;   // mobile: single column
  if (windowWidth.value < 1280) return 2;  // tablet: 2 columns
  return 3;                                 // desktop: 3 columns
});

function handleResizeForWaterfall() {
  windowWidth.value = window.innerWidth;
}

onMounted(() => window.addEventListener('resize', handleResizeForWaterfall));
onUnmounted(() => window.removeEventListener('resize', handleResizeForWaterfall));

/**
 * Estimate the card render height in virtual units based on title, content length, and media count.
 * This guarantees that tall posts (like long single-image photo shoots) don't create deep voids in adjacent columns.
 */
function estimatePostHeight(p: Post): number {
  let h = 90; // Header avatar + meta info + padding
  if (p.title) h += 28;
  if (p.content) {
    const lines = Math.min(Math.ceil(p.content.length / 32), 4);
    h += lines * 18;
  }
  if (p.mediaList?.length) {
    if (p.mediaList.length === 1) {
      h += p.mediaList[0].type === 'video' ? 210 : 320;
    } else if (p.mediaList.length === 2) {
      h += 220;
    } else {
      h += 260;
    }
  }
  h += 40; // Footer timestamp + direct link bar
  return h;
}

// Greedy shortest-column balancing for the Bookmarks waterfall
const bookmarkColumns = computed(() => {
  const count = columnCount.value;
  const cols: Post[][] = Array.from({ length: count }, () => []);
  const colHeights = new Array(count).fill(0);

  filteredBookmarkedPosts.value.forEach((post) => {
    let minCol = 0;
    for (let c = 1; c < count; c++) {
      if (colHeights[c] < colHeights[minCol]) {
        minCol = c;
      }
    }
    cols[minCol].push(post);
    colHeights[minCol] += estimatePostHeight(post) + 20;
  });

  return cols;
});
</script>

<template>
  <section v-if="active" class="space-y-5">
    <!-- Bookmarks Header & Filter Bar -->
    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
      <div>
        <div class="flex items-center gap-2">
          <div class="w-8 h-8 rounded-xl bg-amber-50 dark:bg-amber-950/60 flex items-center justify-center text-amber-500">
            <Bookmark class="w-4 h-4 fill-amber-500" />
          </div>
          <h2 class="font-bold text-lg text-slate-900 dark:text-white">收藏</h2>
          <span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-50 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300 border border-amber-200 dark:border-amber-800">
            {{ filteredBookmarkedPosts.length }} 条收藏
          </span>
        </div>
        <p class="text-xs text-slate-500 mt-1">
          收藏的动态不会被历史清理删除，永久保留。
        </p>
      </div>
    </div>

    <!-- Bookmarks Search & Platform Filter Bar -->
    <div class="bg-white dark:bg-slate-900 rounded-2xl border border-slate-200/80 dark:border-slate-800 p-4 shadow-2xs space-y-3">
      <div class="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        <!-- Search Input -->
        <div class="relative flex-1">
          <Search class="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            v-model="bookmarkSearchQuery"
            type="text"
            placeholder="搜索内容 / 创作者 / #标签…"
            class="w-full pl-9 pr-8 py-2 bg-slate-100 dark:bg-slate-800 border-none rounded-xl text-xs outline-none focus:ring-2 focus:ring-amber-500 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
          />
          <button
            type="button"
            @click="bookmarkSearchQuery = ''"
            class="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full"
          >
            <X class="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <!-- Platform Filter Pills -->
      <div class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs">
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <Filter class="w-3 h-3" />
          平台筛选:
        </span>
        <button
          type="button"
          @click="bookmarkSelectedPlatform = 'all'"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
          :class="bookmarkSelectedPlatform === 'all'
            ? 'bg-amber-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          全部 ({{ context.posts.filter(p => p.isBookmarked).length }})
        </button>
        <template v-for="(cfg, pKey) in PLATFORM_REGISTRY" :key="'bm-p-' + pKey">
          <button
            v-if="context.posts.some(p => p.isBookmarked && p.platform === pKey)"
            type="button"
            @click="bookmarkSelectedPlatform = pKey"
            class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer flex items-center gap-1"
            :class="bookmarkSelectedPlatform === pKey
              ? 'bg-amber-600 text-white shadow-2xs font-semibold'
              : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
          >
            <span>{{ cfg.name }}</span>
            <span class="text-[10px] opacity-75">
              ({{ context.posts.filter(p => p.isBookmarked && p.platform === pKey).length }})
            </span>
          </button>
        </template>
      </div>

      <!-- Account role filter (main / sub / alt / custom) -->
      <div
        v-if="bookmarkRoles.length > 0"
        class="flex flex-wrap items-center gap-1.5 pt-2 border-t border-slate-100 dark:border-slate-800 text-xs"
      >
        <span class="text-[11px] text-slate-400 font-medium mr-1 flex items-center gap-1">
          <UserRound class="w-3 h-3" />
          账号角色:
        </span>
        <button
          type="button"
          @click="bookmarkSelectedRole = 'all'"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
          :class="bookmarkSelectedRole === 'all'
            ? 'bg-amber-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          全部
        </button>
        <button
          v-for="role in bookmarkRoles"
          :key="role.key"
          type="button"
          @click="bookmarkSelectedRole = role.key"
          class="px-2.5 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
          :class="bookmarkSelectedRole === role.key
            ? 'bg-amber-600 text-white shadow-2xs font-semibold'
            : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:hover:bg-slate-700'"
        >
          {{ role.label }}
        </button>
      </div>
    </div>

    <!-- Empty Bookmarks State -->
    <div v-if="filteredBookmarkedPosts.length === 0" class="text-center py-20 bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800">
      <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-amber-50 dark:bg-amber-950/50 flex items-center justify-center text-amber-500">
        <Bookmark class="w-8 h-8" />
      </div>
      <h3 class="text-base font-bold text-slate-800 dark:text-slate-200 mb-1">
        {{ context.posts.some(p => p.isBookmarked) ? '未找到符合条件的收藏动态' : '暂无收藏的动态' }}
      </h3>
      <p class="text-xs text-slate-500 max-w-md mx-auto mb-5 leading-relaxed">
        {{ context.posts.some(p => p.isBookmarked) ? '可以尝试更换搜索关键词或选择全部平台。' : '在动态流中点击 ☆ 收藏喜欢的内容' }}
      </p>
      <button
        type="button"
        @click="context.onGoToFeed"
        class="px-4 py-2 text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl shadow-xs transition-colors cursor-pointer"
      >
        前往动态
      </button>
    </div>

    <!-- Bookmarked Posts Masonry Waterfall Layout -->
    <div v-else class="space-y-6">
      <div class="flex gap-4 xl:gap-5 items-start">
        <div
          v-for="(colPosts, colIdx) in bookmarkColumns"
          :key="'bm-col-' + colIdx"
          class="flex-1 flex flex-col gap-4 xl:gap-5 min-w-0"
        >
          <PostCard
            v-for="post in colPosts"
            :key="'bm-' + post.id"
            :post="post"
            :creators="context.creators"
            :channels="context.channels"
            :bookmarked="Boolean(post.isBookmarked)"
            @bookmark="context.onToggleBookmark"
            @delete="context.onDelete"
            @read="context.onRead"
            @media="context.onOpenMedia"
            @avatar-error="context.onAvatarError"
            @open-reader="context.onOpenReader"
          />
        </div>
      </div>
    </div>
  </section>
</template>
