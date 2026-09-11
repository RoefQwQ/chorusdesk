import { computed, ref, type Ref } from 'vue';
import type { Channel, Creator } from '../../../src/types';
import type { ParsedProfile } from '../../../src/utils/urlParser';
import { creatorService, channelService } from '../../../src/application';
// Catalog reads (creators/channels) still read `db` directly: the popup only
// lists and looks up records here; every write goes through the services
// above, which are the application-layer boundary for persistence.
import { db } from '../../../src/infrastructure/db/database';

import type { AuthorMeta } from './usePageDetection';
import { notifyBadgeRefresh } from '../../../src/utils/badge';

export type AccountRole = 'main' | 'sub' | 'alt' | 'custom';
export type FollowMode = 'new' | 'bind';

export interface QuickFollowDependencies {
  /** Live page-detection state the follow flow reads at action time. */
  parsed: Ref<ParsedProfile | null>;
  detectedAuthorMeta: Ref<AuthorMeta>;
  activeDisplayName: Ref<string>;
}

/**
 * Popup "quick follow" flow: catalog state (creators/channels), creator
 * selection form state and the follow action (create a new creator or bind the
 * channel to an existing one, persist it and trigger the initial fetch).
 *
 * Owns only follow-form state; URL recognition lives in usePageDetection.
 */
export function useQuickFollow(deps: QuickFollowDependencies) {
  const creators = ref<Creator[]>([]);
  const channels = ref<Channel[]>([]);
  const existingChannel = ref<Channel | null>(null);
  const existingCreator = ref<Creator | null>(null);

  // Form inputs
  const mode = ref<FollowMode>('new');
  const newCreatorName = ref('');
  const newCreatorTags = ref('');
  const selectedCreatorId = ref('');
  const creatorSearchQuery = ref('');
  const isEditingCreatorSelection = ref(false);
  const accountRole = ref<AccountRole>('main');
  const customLabel = ref('');
  const saving = ref(false);

  const selectedCreatorObj = computed(() => {
    return creators.value.find(c => c.id === selectedCreatorId.value) ?? null;
  });

  // Live matching existing creators when typing in newCreatorName
  const matchedExistingCreators = computed(() => {
    const q = newCreatorName.value.trim().toLowerCase();
    if (!q) return [];
    return creators.value.filter(c => {
      const matchName = c.name.toLowerCase().includes(q);
      const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
      const matchNote = c.note?.toLowerCase().includes(q);
      const matchId = c.id.toLowerCase().includes(q);
      return matchName || matchTag || matchNote || matchId;
    });
  });

  // Filtered candidates when searching in bind mode
  const filteredCandidateCreators = computed(() => {
    const q = creatorSearchQuery.value.trim().toLowerCase();
    if (!q) return creators.value;
    return creators.value.filter(c => {
      const matchName = c.name.toLowerCase().includes(q);
      const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
      const matchNote = c.note?.toLowerCase().includes(q);
      const matchId = c.id.toLowerCase().includes(q);
      return matchName || matchTag || matchNote || matchId;
    });
  });

  const samePlatformAccounts = computed(() => {
    if (!deps.parsed.value || !selectedCreatorId.value || mode.value !== 'bind') return [];
    return channels.value.filter(
      ch => ch.creatorId === selectedCreatorId.value && ch.platform === deps.parsed.value?.platform
    );
  });

  function selectCreator(c: Creator) {
    selectedCreatorId.value = c.id;
    mode.value = 'bind';
    isEditingCreatorSelection.value = false;
    creatorSearchQuery.value = '';
  }

  function switchToNewCreatorWithQuery(name?: string) {
    mode.value = 'new';
    if (name) newCreatorName.value = name;
    selectedCreatorId.value = '';
  }

  /** Loads the catalog and clears stale "updating" statuses on popup open. */
  async function initCatalog() {
    await channelService.clearStaleUpdatingStatus();
    creators.value = await db.creators.toArray();
    channels.value = await db.channels.toArray();
  }

  /**
   * After a profile URL is recognized: pre-fill the creator name, resolve
   * whether the channel is already followed and pick a sensible default
   * creator candidate for bind mode.
   */
  async function onUrlResolved(res: ParsedProfile | null) {
    if (!res) {
      existingChannel.value = null;
      existingCreator.value = null;
      return;
    }
    if (!newCreatorName.value || newCreatorName.value === res.accountId) {
      newCreatorName.value = res.suggestedName || '';
    }
    const channelId = `${res.platform}:${res.accountId}`;
    const foundCh = await db.channels.get(channelId);
    if (foundCh) {
      existingChannel.value = foundCh;
      existingCreator.value = (await db.creators.get(foundCh.creatorId)) || null;
    } else {
      existingChannel.value = null;
      existingCreator.value = null;
      if (creators.value.length > 0) {
        selectedCreatorId.value = creators.value[0].id;
      }
    }
  }

  /**
   * Persists the follow: creates a new creator (new mode) or binds the channel
   * to the selected one, then triggers the on-demand initial fetch.
   */
  async function handleSave() {
    const current = deps.parsed.value;
    if (!current) return;
    saving.value = true;

    try {
      let targetCreatorId = selectedCreatorId.value;

      if (mode.value === 'new' || !targetCreatorId) {
        const creatorName = newCreatorName.value.trim() || deps.activeDisplayName.value || current.suggestedName || '新创作者';
        const tags = newCreatorTags.value
          .split(/[,，\s]+/)
          .map(t => t.trim())
          .filter(Boolean);

        const newCreator: Creator = {
          id: 'c_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
          name: creatorName,
          avatar: deps.detectedAuthorMeta.value.avatar || '',
          tags,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };

        await creatorService.save(newCreator);
        targetCreatorId = newCreator.id;
        creators.value.push(newCreator);
      }

      const channelId = `${current.platform}:${current.accountId}`;
      const roleLabel = accountRole.value === 'custom'
        ? (customLabel.value.trim() || '自定义频道')
        : (accountRole.value === 'main' ? '主账号' : accountRole.value === 'sub' ? '日常小号' : '里号/差分');

      const channelDisplayName = deps.activeDisplayName.value || current.suggestedName || current.accountId;

      const newChannel: Channel = {
        id: channelId,
        creatorId: targetCreatorId,
        platform: current.platform,
        accountId: current.accountId,
        displayName: channelDisplayName,
        avatarUrl: deps.detectedAuthorMeta.value.avatar || undefined,
        profileUrl: current.cleanUrl,
        label: roleLabel,
        accountRole: accountRole.value,
        status: 'idle',
      };

      await channelService.upsert(newChannel);


      // Initial fetch, done by the service worker. It must not run here: the
      // popup is dismissed by a click anywhere outside it, and a fetch owned by
      // this window dies with it — the channel would be stored with no posts and
      // nothing would retry. `sendMessage` keeps the worker alive until it
      // answers, so the fetch survives the popup closing. It also keeps the
      // platform adapters out of this bundle (queue item B20).
      void chrome.runtime
        .sendMessage({ type: 'SYNC_CHANNEL', channelId: newChannel.id, limit: 5 })
        .then((res: { success?: boolean; error?: string } | undefined) => {
          if (res && res.success === false) console.warn('[Chorus] 首次抓取失败:', res.error);
          return notifyBadgeRefresh();
        })
        .catch((e) => console.error('[Chorus] 首次抓取失败:', e));

      existingChannel.value = newChannel;
      existingCreator.value = (await db.creators.get(targetCreatorId)) || null;
    } catch (err) {
      console.error('Save failed', err);
    } finally {
      saving.value = false;
    }
  }

  return {
    creators,
    channels,
    existingChannel,
    existingCreator,
    mode,
    newCreatorName,
    newCreatorTags,
    selectedCreatorId,
    creatorSearchQuery,
    isEditingCreatorSelection,
    accountRole,
    customLabel,
    saving,
    selectedCreatorObj,
    matchedExistingCreators,
    filteredCandidateCreators,
    samePlatformAccounts,
    initCatalog,
    onUrlResolved,
    selectCreator,
    switchToNewCreatorWithQuery,
    handleSave,
  };
}
