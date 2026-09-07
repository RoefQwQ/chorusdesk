<script setup lang="ts">
import { onMounted } from 'vue';
import { ExternalLink, LayoutDashboard } from 'lucide-vue-next';
import { usePageDetection } from './composables/usePageDetection';
import { useQuickFollow } from './composables/useQuickFollow';
import { useRplaySync } from './composables/useRplaySync';
import { usePopupNavigation } from './composables/usePopupNavigation';
import RplaySyncBanner from './components/RplaySyncBanner.vue';
import TargetInfoCard from './components/TargetInfoCard.vue';
import AlreadyFollowedCard from './components/AlreadyFollowedCard.vue';
import QuickFollowForm from './components/QuickFollowForm.vue';
import ManualAddCard from './components/ManualAddCard.vue';

const page = usePageDetection();
const { loading, manualUrl, parsed, detectedAuthorMeta, isRplayTab, activeDisplayName } = page;

const follow = useQuickFollow({
  parsed,
  detectedAuthorMeta,
  activeDisplayName,
});
const {
  creators,
  channels,
  existingChannel,
  existingCreator,
  mode,
  newCreatorName,
  newCreatorTags,
  creatorSearchQuery,
  isEditingCreatorSelection,
  selectedCreatorId,
  selectedCreatorObj,
  accountRole,
  customLabel,
  saving,
  matchedExistingCreators,
  filteredCandidateCreators,
  samePlatformAccounts,
  initCatalog,
  onUrlResolved,
  handleSave,
} = follow;

const { rplaySyncState, rplaySyncMessage, triggerRplaySync, markSyncedIfStored } = useRplaySync();
const { openDashboard } = usePopupNavigation();

/** Writes a detected author name back into the new-creator name field. */
function applyDetectedName(name?: string) {
  if (name) {
    newCreatorName.value = name;
  }
}

async function handleRecognizedUrl(url: string) {
  const res = page.resolveUrl(url);
  await onUrlResolved(res);

  // Authoritative fallback for Bilibili: public User Card API directly by UID
  if (res?.platform === 'bilibili' && res.accountId) {
    const name = await page.fetchBilibiliCard(res.accountId);
    applyDetectedName(name);
  }
}

async function handleManualParse() {
  if (!manualUrl.value) return;
  detectedAuthorMeta.value = {};
  await handleRecognizedUrl(manualUrl.value);
}

onMounted(async () => {
  try {
    await initCatalog();

    const tab = await page.getActiveTab();
    if (tab?.url) {
      page.currentUrl.value = tab.url;
      await handleRecognizedUrl(tab.url);

      if (tab.id) {
        const name = await page.extractActiveTabAuthorMeta(tab.id, tab.url);
        applyDetectedName(name);
      }

      if (tab.url.includes('rplay.live')) {
        // Check if token already exists first
        await markSyncedIfStored();
        // Also trigger live sync from tab
        triggerRplaySync();
      }
    }
  } catch (e) {
    console.error('Failed to init popup', e);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="p-4 flex flex-col justify-between min-h-[460px] text-xs">
    <!-- Header -->
    <div class="flex items-center justify-between pb-3 border-b border-slate-200 dark:border-slate-800">
      <div class="flex items-center gap-2.5">
        <img src="/icons/icon-48.png" class="w-7 h-7 rounded-xl shadow-xs shrink-0" alt="Chorus" />
        <div>
          <h1 class="font-bold text-sm tracking-tight text-slate-900 dark:text-white">Chorus</h1>
          <p class="text-[10px] text-slate-500">创作者聚合追踪</p>
        </div>
      </div>
      <button
        @click="openDashboard"
        title="打开面板"
        class="flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-300 dark:hover:bg-indigo-900/50 rounded-md transition-colors cursor-pointer"
      >
        <LayoutDashboard class="w-3.5 h-3.5" />
        <span>打开面板</span>
      </button>
    </div>

    <!-- Rplay Page Live Sync Banner -->
    <RplaySyncBanner
      v-if="isRplayTab"
      :state="rplaySyncState"
      :message="rplaySyncMessage"
      @sync="triggerRplaySync"
    />

    <!-- Body content -->
    <div class="my-3 flex-1">
      <!-- Loading -->
      <div v-if="loading" class="py-12 text-center text-slate-400">
        正在识别...
      </div>

      <!-- Detected Platform Card -->
      <div v-else-if="parsed" class="space-y-3">
        <!-- Target Info -->
        <TargetInfoCard
          :parsed="parsed"
          :author-meta="detectedAuthorMeta"
          :display-name="activeDisplayName"
        />

        <!-- If Already Added -->
        <AlreadyFollowedCard
          v-if="existingChannel"
          :existing-channel="existingChannel"
          :existing-creator="existingCreator"
          @open-dashboard="openDashboard"
        />

        <!-- Add Options -->
        <QuickFollowForm
          v-else
          :mode="mode"
          :creators="creators"
          :channels="channels"
          :new-creator-name="newCreatorName"
          :new-creator-tags="newCreatorTags"
          :creator-search-query="creatorSearchQuery"
          :is-editing-creator-selection="isEditingCreatorSelection"
          :selected-creator-id="selectedCreatorId"
          :selected-creator-obj="selectedCreatorObj"
          :account-role="accountRole"
          :custom-label="customLabel"
          :saving="saving"
          :matched-existing-creators="matchedExistingCreators"
          :filtered-candidate-creators="filteredCandidateCreators"
          :same-platform-accounts="samePlatformAccounts"
          @update:mode="mode = $event"
          @update:new-creator-name="newCreatorName = $event"
          @update:new-creator-tags="newCreatorTags = $event"
          @update:creator-search-query="creatorSearchQuery = $event"
          @update:is-editing-creator-selection="isEditingCreatorSelection = $event"
          @update:account-role="accountRole = $event"
          @update:custom-label="customLabel = $event"
          @select="follow.selectCreator($event)"
          @switch-new="follow.switchToNewCreatorWithQuery($event)"
          @save="handleSave"
        />
      </div>

      <!-- Unrecognized Page / Manual Add -->
      <ManualAddCard
        v-else
        :manual-url="manualUrl"
        @update:manual-url="manualUrl = $event"
        @parse="handleManualParse"
      />
    </div>

    <!-- Bottom Statistics & Direct Dashboard Access -->
    <div class="pt-3 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500">
      <div class="flex items-center gap-2">
        <span>关注: <strong class="text-slate-800 dark:text-slate-200">{{ creators.length }}</strong></span>
      </div>
      <button
        @click="openDashboard"
        class="flex items-center gap-1 text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 font-medium"
      >
        <span>打开面板</span>
        <ExternalLink class="w-3 h-3" />
      </button>
    </div>
  </div>
</template>
