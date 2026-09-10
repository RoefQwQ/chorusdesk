<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick } from 'vue';
import {
  PLATFORM_REGISTRY,
  type Creator,
  type Channel,
  type AppSettings,
} from '../../src/types';
import {
  RefreshCw,
  Plus,
  Settings,
  Users,
  LayoutGrid,
  Trash2,
  Moon,
  Sun,
  Bookmark,
  ChevronDown,
  RotateCcw,
} from 'lucide-vue-next';
import MediaLightbox from './components/MediaLightbox.vue';
import AvatarPickerModal from './components/AvatarPickerModal.vue';
import DeletedPostsModal from './components/DeletedPostsModal.vue';
import AddCreatorModal from './components/AddCreatorModal.vue';
import DeepSyncModal from './components/DeepSyncModal.vue';
import TagEditorModal from './components/TagEditorModal.vue';
import ScrollActionToolbar from './components/ScrollActionToolbar.vue';
import FeedView from './views/FeedView.vue';
import CreatorsView from './views/CreatorsView.vue';
import BookmarksView from './views/BookmarksView.vue';
import SettingsView from './views/SettingsView.vue';
import { useDarkMode } from './composables/useDarkMode';
import { useDashboardShell } from './composables/useDashboardShell';
import { useDeletedPosts } from './composables/useDeletedPosts';
import { useCreatorVisibility } from './composables/useCreatorVisibility';
import { usePlatformLogins } from './composables/usePlatformLogins';
import { useFeedFilters } from './composables/useFeedFilters';
import { useCreatorsManager } from './composables/useCreatorsManager';
import { usePostActions } from './composables/usePostActions';
import { useDeepSync } from './composables/useDeepSync';
import { useSyncActions } from './composables/useSyncActions';
import { useBackupManager } from './composables/useBackupManager';
import { useMediaMaintenance } from './composables/useMediaMaintenance';
import { notifyBadgeRefresh } from '../../src/utils/badge';

// ==================== DATA & CROSS-PAGE STATE ====================
const activeTab = ref<'feed' | 'creators' | 'bookmarks' | 'settings'>('feed');

// Infrastructure shell — constructs db/settings/stats/sync dependencies once.
const shell = useDashboardShell();
const {
  creators,
  channels,
  posts,
  dbStats,
  settings,
  reloadFeedData,
  loadSettings,
  saveSettings: persistSettings,
  clearStaleUpdatingStatus,
  updateChannel,
  notifyAutoSyncChanged,
} = shell;

// Hidden-creator visibility preferences (feed sidebar / directory).
const creatorVisibility = useCreatorVisibility({ getChannels: () => channels.value });
const {
  hiddenCreatorIds,
  hiddenCreatorPlatforms,
  toggleHideCreator,
  toggleHideCreatorPlatform,
  unhideAllCreators,
  resetCreatorHiddenPlatforms,
  getCreatorPlatforms,
} = creatorVisibility;

// Feed filtering & visibility state (search/platform/tags/reposts/text-only).
const feedFilters = useFeedFilters({
  posts,
  creators,
  channels,
  hiddenCreatorIds,
  hiddenCreatorPlatforms,
  settings,
});
const {
  searchQuery,
  selectedPlatform,
  includeTags,
  excludeTags,
  hideReposts,
  hideTextOnly,
  allTags,
  repostsCount,
  textOnlyCount,
  toggleHideReposts,
  toggleHideTextOnly,
  cycleTagFilter,
  clearAllTagFilters,
  clearTagFromFilters,
  getTagFilterState,
  visibleCreatorsForFilter,
  hiddenCreatorsInFilterCount,
  platformPostCounts,
  filteredPosts,
} = feedFilters;

// Sync orchestration (header "sync all", single creator/channel refresh).
const syncActions = useSyncActions({
  getCreators: () => creators.value,
  getChannels: () => channels.value,
  getItemsPerFetch: () => settings.value.itemsPerFetch,
  getRequestDelayMs: () => settings.value.requestDelayMs,
  getHideReposts: () => hideReposts.value,
  reloadData: () => reloadData(),
});
const {
  isRefreshingAll,
  refreshProgress,
  handleRefreshAll,
  handleRefreshCreator,
  handleRefreshChannel,
  batchRefreshCreators,
} = syncActions;

// Deleted-posts recycle bin (restores / sync-restore / permanent purge).
const recycleBin = useDeletedPosts({
  reloadData: () => reloadData(),
  refreshAll: (restoreDeleted = false) => handleRefreshAll(restoreDeleted),
  removePostFromFeed: (postId) => {
    posts.value = posts.value.filter(post => post.id !== postId);
  },
  getChannels: () => channels.value,
  channelUpdate: updateChannel,
  itemsPerFetch: () => settings.value.itemsPerFetch,
});
const {
  deletedPostCount,
  deletedPostsList,
  showDeletedPostsModal,
  deletedPostsSearchQuery,
  showSyncMenu,
  filteredDeletedPostsList,
  refreshDeletedPostsList,
  handleDeletePost,
  openDeletedPostsModal,
  handleRestoreSingleDeleted,
  handleRestoreAllAndSync,
  handlePermanentlyDelete,
  handleEmptyRecycleBin,
} = recycleBin;

// Bookmark / read state actions (feed cards & bookmarks view).
const { toggleBookmarkPost, markPostRead } = usePostActions({ dbStats, posts });

// Creator lifecycle controller (add/bind, tags, avatar, cascade deletes, demo).
const creatorsManager = useCreatorsManager({
  creators,
  channels,
  posts,
  reloadData: () => reloadData(),
  clearTagFromFilters: (tag) => clearTagFromFilters(tag),
});
const {
  addModalOpenRequest,
  isSubmittingAdd,
  avatarPickerCreator,
  editingTagCreator,
  openAddModal,
  openAvatarPicker,
  selectPrimaryAvatar,
  getCreatorAvatar,
  handleAvatarError,
  openEditCreatorTags,
  saveCreatorTags,
  deleteGlobalTag,
  submitAdd,
  deleteCreator,
  deleteCreatorsBatch,
  deleteChannel,
  cycleChannelRole,
  reorderCreators,
  loadDemoData,
} = creatorsManager;

// Deep history-sync orchestration (DeepSyncModal state + per-channel driver).
const deepSync = useDeepSync({
  getChannels: () => channels.value,
  reloadData: () => reloadData(),
});
const {
  deepSyncTargetCreator,
  deepSyncInitialChannelId,
  isDeepSyncRunning,
  deepSyncLogs,
  deepSyncTotalNew,
  deepSyncCurrentStatus,
  openDeepSyncModal,
  startDeepSync,
  stopDeepSync,
} = deepSync;

// Backup export / import (settings page) — delegates to src/application.
const { exportBackup, exportBackupToFile, handleImportFile } = useBackupManager({
  reloadData: () => reloadData(),
  settings,
});

// Settings-page data maintenance (media heal / old-post cleanup).
const {
  isHealingMedia,
  isCleaningStorage,
  handleHealBrokenMedia,
  handleCleanupPosts,
} = useMediaMaintenance({ reloadData: () => reloadData() });

// UI controls
const isDarkModeState = useDarkMode();
const { isDarkMode, initDarkMode, toggleDarkMode } = isDarkModeState;

// Lightbox
const lightboxMedia = ref<{ url: string; originalUrl?: string; type: string; title?: string } | null>(null);

// Right sidebar creator inline accordion state
const expandedCreatorIds = ref<Set<string>>(new Set());

function toggleExpandCreator(creatorId: string) {
  if (expandedCreatorIds.value.has(creatorId)) {
    expandedCreatorIds.value.delete(creatorId);
  } else {
    expandedCreatorIds.value.add(creatorId);
  }
  expandedCreatorIds.value = new Set(expandedCreatorIds.value);
}

// Platform login detector status
const { platformLoginStatus, isCheckingLogins, checkPlatformLogins } = usePlatformLogins();

async function reloadData() {
  await reloadFeedData();
  await refreshDeletedPostsList();
  // reloadData is the convergence point for sync / restore / import / dig
  // flows; each may add or remove unread posts the toolbar badge shows.
  notifyBadgeRefresh();
}

// Global shortcut: [R] refreshes the feed on the feed tab.
function handleGlobalShortcut(event: KeyboardEvent) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName)) return;
  if (event.key.toLowerCase() === 'r' && activeTab.value === 'feed' && !isRefreshingAll.value) {
    event.preventDefault();
    handleRefreshAll();
  }
}

// Escape handling for the lightbox now lives in BaseModal (focus-trapped
// dialog), so no global keydown listener is needed for it anymore.

// Tab scroll position preservation
const tabScrollPositions: Record<string, number> = {};

watch(activeTab, async (newTab, oldTab) => {
  if (oldTab) {
    tabScrollPositions[oldTab] = window.scrollY || document.documentElement.scrollTop || 0;
  }
  if (newTab === 'settings') {
    await refreshDeletedPostsList();
  }
  await nextTick();
  // Restore saved scroll position for the target tab
  const targetY = tabScrollPositions[newTab] || 0;
  window.scrollTo({ top: targetY, behavior: 'instant' });
  // Double raf to guarantee restoration even if child components recalculate DOM heights
  requestAnimationFrame(() => {
    window.scrollTo({ top: targetY, behavior: 'instant' });
  });
});

onMounted(async () => {
  // Clear any hanging updating status from previous reloads/crashes so icons don't spin perpetually
  await clearStaleUpdatingStatus();
  await reloadData();
  await loadSettings();
  hideReposts.value = Boolean(settings.value.hideReposts);
  hideTextOnly.value = Boolean(settings.value.hideTextOnly);
  initDarkMode();
  window.addEventListener('keydown', handleGlobalShortcut);
  await checkPlatformLogins();
});

onUnmounted(() => {
  window.removeEventListener('keydown', handleGlobalShortcut);
});

async function updateDashboardSettings(patch: Partial<AppSettings>) {
  settings.value = await persistSettings(patch);
}

// Sidebar platform list custom order (persisted via AppSettings.platformOrder).
const platformOrder = computed<string[]>(() => settings.value.platformOrder || []);

async function handlePlatformOrderChange(order: string[]) {
  settings.value = await persistSettings({ platformOrder: order });
}

// ==================== CREATORS DIRECTORY DERIVED DATA (view context) ====================
// Post count map per creator
const creatorPostCountMap = computed(() => {
  const map: Record<string, number> = {};
  for (const p of posts.value) {
    map[p.creatorId] = (map[p.creatorId] || 0) + 1;
  }
  return map;
});

// Platform distribution among creators for filter pill badges
const creatorCountByPlatform = computed(() => {
  const counts: Record<string, number> = { all: creators.value.length };
  for (const c of creators.value) {
    const chs = channels.value.filter(ch => ch.creatorId === c.id);
    const platforms = new Set(chs.map(ch => ch.platform));
    platforms.forEach(p => {
      counts[p] = (counts[p] || 0) + 1;
    });
  }
  return counts;
});

// ==================== VIEW CONTEXT WIRING ====================
// Feed/creators/bookmarks/settings contexts expose the exact state + action
// handles the extracted view components require; no logic duplicated here.
const feedContext = computed(() => ({
  searchQuery: searchQuery.value,
  selectedPlatform: selectedPlatform.value,
  PLATFORM_REGISTRY,
  platformOrder: platformOrder.value,
  platformPostCounts: platformPostCounts.value,
  repostsCount: repostsCount.value,
  textOnlyCount: textOnlyCount.value,
  hideReposts: hideReposts.value,
  hideTextOnly: hideTextOnly.value,
  allTags: allTags.value,
  includeTags: includeTags.value,
  excludeTags: excludeTags.value,
  creators: creators.value,
  channels: channels.value,
  filteredPosts: filteredPosts.value,
  visibleCreatorsForFilter: visibleCreatorsForFilter.value,
  hiddenCreatorsInFilterCount: hiddenCreatorsInFilterCount.value,
  hiddenCreatorIds: hiddenCreatorIds.value,
  expandedCreatorIds: expandedCreatorIds.value,
  hiddenCreatorPlatforms: hiddenCreatorPlatforms.value,
  lightboxMedia: lightboxMedia.value,
  toggleHideReposts,
  toggleHideTextOnly,
  cycleTagFilter,
  clearAllTagFilters,
  getTagFilterState,
  loadDemoData,
  openAddModal,
  toggleBookmarkPost,
  handleDeletePost,
  markPostRead,
  handleAvatarError,
  unhideAllCreators,
  toggleExpandCreator,
  toggleHideCreator,
  toggleHideCreatorPlatform,
  resetCreatorHiddenPlatforms,
  getCreatorAvatar,
  getCreatorPlatforms,
}));

const creatorsContext = computed(() => ({
  creators: creators.value,
  channels: channels.value,
  creatorPostCountMap: creatorPostCountMap.value,
  creatorCountByPlatform: creatorCountByPlatform.value,
  platformOrder: platformOrder.value,
  syncingCreatorIds: syncActions.syncingCreatorIds.value,
  syncingChannelIds: syncActions.syncingChannelIds.value,
}));

const bookmarksContext = computed(() => ({
  posts: posts.value,
  creators: creators.value,
  channels: channels.value,
  hideTextOnly: hideTextOnly.value,
  onGoToFeed: () => { activeTab.value = 'feed'; },
  onToggleBookmark: toggleBookmarkPost,
  onDelete: handleDeletePost,
  onRead: markPostRead,
  onOpenMedia: (media: { url: string; originalUrl?: string; type: string; title?: string }) => { lightboxMedia.value = media; },
  onAvatarError: handleAvatarError,
}));

const settingsContext = computed(() => ({
  settings: settings.value,
  posts: posts.value,
  creators: creators.value,
  dbStats: dbStats.value,
  platformLoginStatus: platformLoginStatus.value,
  isCheckingLogins: isCheckingLogins.value,
  deletedPostCount: deletedPostCount.value,
  deletedPostsList: deletedPostsList.value,
  filteredDeletedPostsList: filteredDeletedPostsList.value,
  deletedPostsSearchQuery: deletedPostsSearchQuery.value,
  isHealingMedia: isHealingMedia.value,
  isCleaningStorage: isCleaningStorage.value,
  onAddSource: () => openAddModal('new', undefined, 'https://'),
  onCheckPlatformLogins: checkPlatformLogins,
  onExportBackupToFile: exportBackupToFile,
  onExportBackup: exportBackup,
  onImportFile: handleImportFile,
  onLoadDemoData: loadDemoData,
  onUpdateSettings: updateDashboardSettings,
  onNotifyAutoSyncChanged: notifyAutoSyncChanged,
  onRefresh: reloadData,
  onHealBrokenMedia: handleHealBrokenMedia,
  onCleanupPosts: handleCleanupPosts,
  onRestoreAll: handleRestoreAllAndSync,
  onEmptyRecycleBin: handleEmptyRecycleBin,
  onRestoreOne: handleRestoreSingleDeleted,
  onPermanentDelete: handlePermanentlyDelete,
  onSearchDeleted: (q: string) => { deletedPostsSearchQuery.value = q; },
}));

// CreatorsView emits its action intents; map them to the App-level handlers.
function onCreatorsAdd(payload: { mode: 'new' | 'channel'; creator?: Creator | null }) {
  openAddModal(payload.mode, payload.creator ?? undefined);
}
function onCreatorsDeepSync(payload: { creator: Creator; channelId?: string }) {
  openDeepSyncModal(payload.creator, payload.channelId);
}
function onCreatorsEditTags(creator: Creator) {
  openEditCreatorTags(creator);
}
function onCreatorsRefreshChannel(payload: { channel: Channel; force: boolean }) {
  handleRefreshChannel(payload.channel, payload.force);
}
function onCreatorsBatchRefresh(creatorIds: string[]) {
  batchRefreshCreators(creatorIds);
}
function onCreatorsBatchDelete(creatorIds: string[]) {
  deleteCreatorsBatch(creatorIds);
}

</script>

<template>
  <div class="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-800 dark:text-slate-100">
    <!-- Top Navigation Bar -->
    <header class="sticky top-0 z-40 bg-white/85 dark:bg-slate-900/85 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800 transition-colors">
      <div class="w-full max-w-[98%] 2xl:max-w-[96%] mx-auto px-3 sm:px-6 h-16 flex items-center justify-between">
        <!-- Logo & Title -->
        <div class="flex items-center gap-3">
          <img src="/icons/icon-48.png" class="w-9 h-9 rounded-xl shadow-md shadow-indigo-500/25 shrink-0" alt="Chorus" />
          <div>
            <h1 class="font-black text-lg tracking-tight text-slate-900 dark:text-white flex items-center gap-2">
              Chorus
              <span class="text-[10px] font-normal px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800">
                轻量展台
              </span>
            </h1>
            <p class="text-[11px] text-slate-500 dark:text-slate-400">聚合多平台创作者 · 一处浏览全部动态</p>
          </div>
        </div>

        <!-- Tab Switcher -->
        <nav class="flex items-center gap-1 p-1 bg-slate-100 dark:bg-slate-800/80 rounded-xl">
          <button
            @click="activeTab = 'feed'"
            :class="activeTab === 'feed' ? 'bg-white dark:bg-slate-700/80 shadow-xs text-indigo-600 dark:text-indigo-300 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <LayoutGrid class="w-4 h-4" />
            <span>动态</span>
            <span v-if="posts.length" class="text-[10px] px-1.5 py-0.2 bg-slate-200 dark:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300">
              {{ posts.length }}
            </span>
          </button>
          <button
            @click="activeTab = 'creators'"
            :class="activeTab === 'creators' ? 'bg-white dark:bg-slate-700/80 shadow-xs text-indigo-600 dark:text-indigo-300 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Users class="w-4 h-4" />
            <span>关注</span>
            <span v-if="creators.length" class="text-[10px] px-1.5 py-0.2 bg-slate-200 dark:bg-slate-700 rounded-full text-slate-700 dark:text-slate-300">
              {{ creators.length }}
            </span>
          </button>
          <button
            @click="activeTab = 'bookmarks'"
            :class="activeTab === 'bookmarks' ? 'bg-white dark:bg-slate-700/80 shadow-xs text-amber-600 dark:text-amber-400 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Bookmark class="w-4 h-4" :class="{ 'fill-amber-500 text-amber-500': activeTab === 'bookmarks' }" />
            <span>收藏</span>
          </button>
          <button
            @click="activeTab = 'settings'"
            :class="activeTab === 'settings' ? 'bg-white dark:bg-slate-700/80 shadow-xs text-indigo-600 dark:text-indigo-300 font-semibold' : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'"
            class="flex items-center gap-1.5 px-4 py-2 text-xs rounded-lg transition-all cursor-pointer"
          >
            <Settings class="w-4 h-4" />
            <span>设置</span>
          </button>
        </nav>

        <!-- Right Action Buttons -->
        <div class="flex items-center gap-2">
          <!-- Refresh All Button Group -->
          <div class="relative inline-flex items-stretch rounded-xl shadow-xs">
            <button
              type="button"
              @click="handleRefreshAll(false)"
              :disabled="isRefreshingAll || channels.length === 0"
              class="flex items-center gap-2 px-3.5 py-2 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-all cursor-pointer"
              :class="deletedPostCount > 0 ? 'rounded-l-xl' : 'rounded-xl'"
              title="一键同步最新动态（默认跳过已删除的动态）"
            >
              <RefreshCw class="w-4 h-4 shrink-0" :class="{ 'animate-spin': isRefreshingAll }" />
              <span class="leading-none">{{ isRefreshingAll ? `同步中 ${refreshProgress.current}/${refreshProgress.total}` : '同步全部' }}</span>
            </button>
            <div v-if="deletedPostCount > 0" class="relative flex items-stretch">
              <button
                type="button"
                @click="showSyncMenu = !showSyncMenu"
                :disabled="isRefreshingAll"
                class="px-2.5 flex items-center justify-center text-white bg-indigo-600 hover:bg-indigo-700 rounded-r-xl border-l border-indigo-500/80 cursor-pointer transition-colors"
                title="同步选项与已删除动态管理"
              >
                <ChevronDown class="w-4 h-4 transition-transform shrink-0" :class="{ 'rotate-180': showSyncMenu }" />
              </button>
              <!-- Sync Menu Dropdown -->
              <div
                v-if="showSyncMenu"
                class="fixed inset-0 z-40"
                @click="showSyncMenu = false"
              ></div>
              <div
                v-if="showSyncMenu"
                class="absolute right-0 top-full mt-1.5 w-64 bg-white dark:bg-slate-900 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-800 p-1.5 z-50 text-xs space-y-1"
              >
                <button
                  type="button"
                  @click="showSyncMenu = false; handleRefreshAll(false)"
                  class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div class="flex items-center gap-2">
                    <RefreshCw class="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
                    <span class="font-semibold text-slate-800 dark:text-slate-200">一键同步全部 (常规)</span>
                  </div>
                  <span class="text-[10px] text-slate-400">跳过已删除</span>
                </button>
                <button
                  type="button"
                  @click="showSyncMenu = false; handleRefreshAll(true)"
                  class="w-full text-left px-3 py-2.5 rounded-xl hover:bg-indigo-50 dark:hover:bg-indigo-950/50 text-indigo-600 dark:text-indigo-400 flex items-center justify-between transition-colors cursor-pointer"
                >
                  <div class="flex items-center gap-2">
                    <RotateCcw class="w-3.5 h-3.5" />
                    <span class="font-semibold">同步并恢复已删除动态</span>
                  </div>
                  <span class="px-1.5 py-0.5 rounded text-[10px] bg-indigo-100 dark:bg-indigo-900/60 font-bold">{{ deletedPostCount }}</span>
                </button>
                <div class="h-px bg-slate-100 dark:bg-slate-800 my-1"></div>
                <button
                  type="button"
                  @click="showSyncMenu = false; openDeletedPostsModal()"
                  class="w-full text-left px-3 py-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-600 dark:text-slate-400 flex items-center gap-2 transition-colors cursor-pointer"
                >
                  <Trash2 class="w-3.5 h-3.5 text-slate-400" />
                  <span>管理已删除动态记录 ({{ deletedPostCount }})...</span>
                </button>
              </div>
            </div>
          </div>

          <!-- Add Creator Button -->
          <button
            @click="openAddModal('new')"
            class="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 dark:text-slate-200 bg-white dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700 border border-slate-200 dark:border-slate-700 rounded-xl transition-all cursor-pointer"
          >
            <Plus class="w-4 h-4" />
            <span>添加创作者</span>
          </button>

          <!-- Dark Mode Toggle -->
          <button
            @click="toggleDarkMode"
            class="p-2 text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="切换浅色/暗黑主题"
          >
            <Moon v-if="!isDarkMode" class="w-4 h-4" />
            <Sun v-else class="w-4 h-4" />
          </button>
        </div>
      </div>
    </header>
    <!-- Main Container -->
    <main class="flex-1 w-full max-w-[98%] 2xl:max-w-[96%] mx-auto px-3 sm:px-6 py-5">

      <FeedView
        v-show="activeTab === 'feed'"
        :context="feedContext"
        @update:searchQuery="searchQuery = $event"
        @update:selectedPlatform="selectedPlatform = $event"
        @reorder-platforms="handlePlatformOrderChange"
        @update:lightboxMedia="lightboxMedia = $event"
      />

      <CreatorsView
        v-show="activeTab === 'creators'"
        :context="creatorsContext"
        @add="onCreatorsAdd"
        @avatar-picker="openAvatarPicker"
        @deep-sync="onCreatorsDeepSync"
        @edit-tags="onCreatorsEditTags"
        @refresh-creator="handleRefreshCreator"
        @refresh-channel="onCreatorsRefreshChannel"
        @delete-creator="deleteCreator"
        @delete-channel="deleteChannel"
        @cycle-channel-role="cycleChannelRole"
        @reorder-creators="reorderCreators"
        @batch-refresh="onCreatorsBatchRefresh"
        @batch-delete="onCreatorsBatchDelete"
        @demo-data="loadDemoData"
      />

      <BookmarksView
        v-show="activeTab === 'bookmarks'"
        :active="activeTab === 'bookmarks'"
        :context="bookmarksContext"
      />

      <SettingsView
        v-show="activeTab === 'settings'"
        :active="activeTab === 'settings'"
        :context="settingsContext"
      />
    </main>

    <AddCreatorModal
      v-if="addModalOpenRequest"
      :request="addModalOpenRequest"
      :creators="creators"
      :channels="channels"
      :submitting="isSubmittingAdd"
      @close="addModalOpenRequest = null"
      @submit="submitAdd"
    />

    <DeepSyncModal
      v-if="deepSyncTargetCreator"
      :creator="deepSyncTargetCreator"
      :channels="channels"
      :running="isDeepSyncRunning"
      :current-status="deepSyncCurrentStatus"
      :logs="deepSyncLogs"
      :total-new="deepSyncTotalNew"
      :default-only-original="hideReposts"
      :initial-channel-id="deepSyncInitialChannelId"
      @close="deepSyncTargetCreator = null"
      @start="startDeepSync"
      @stop="stopDeepSync"
    />

    <TagEditorModal
      v-if="editingTagCreator"
      :creator="editingTagCreator"
      :all-tags="allTags"
      :delete-global-tag="deleteGlobalTag"
      @close="editingTagCreator = null"
      @save="saveCreatorTags"
    />

    <!-- Floating Actions: Scroll to top, mark reading position, jump to mark -->
    <!-- Aligns with the right-hand creator filter card column (lg:w-64 xl:w-68) -->
    <div class="fixed bottom-6 inset-x-0 pointer-events-none z-40">
      <div class="w-full max-w-[98%] 2xl:max-w-[96%] mx-auto px-3 sm:px-6 flex justify-end">
        <div class="w-auto lg:w-64 xl:w-68 flex justify-end lg:justify-center pointer-events-auto">
          <ScrollActionToolbar />
        </div>
      </div>
    </div>

    <MediaLightbox v-if="lightboxMedia" :media="lightboxMedia" @close="lightboxMedia = null" />
  </div>
  <AvatarPickerModal
    v-if="avatarPickerCreator"
    :creator="avatarPickerCreator"
    :channels="channels"
    :current-avatar="getCreatorAvatar(avatarPickerCreator)"
    @close="avatarPickerCreator = null"
    @select="(url: string) => selectPrimaryAvatar(avatarPickerCreator!, url)"
  />

  <DeletedPostsModal
    v-if="showDeletedPostsModal"
    :records="deletedPostsList"
    :filtered-records="filteredDeletedPostsList"
    :search-query="deletedPostsSearchQuery"
    @close="showDeletedPostsModal = false"
    @update:search-query="deletedPostsSearchQuery = $event"
    @restore-one="handleRestoreSingleDeleted"
    @permanent-delete="handlePermanentlyDelete"
    @restore-all-and-sync="handleRestoreAllAndSync"
  />
</template>
