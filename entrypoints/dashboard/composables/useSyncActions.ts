import { ref } from 'vue';
import type { Creator, Channel } from '../../../src/types';
import { updateChannel, updateCreator, batchUpdateChannelsInterleaved, clearStaleUpdatingStatus } from '../../../src/sync';

export interface SyncActionsDependencies {
  /** Live lists the refresh flows operate on and summarize. */
  getCreators: () => Creator[];
  getChannels: () => Channel[];
  getItemsPerFetch: () => number;
  /** Per-request pacing delay in ms (settings.requestDelayMs). */
  getRequestDelayMs: () => number;
  getHideReposts: () => boolean;
  reloadData: () => Promise<void>;
}

export interface RefreshProgress {
  current: number;
  total: number;
}

/**
 * On-demand sync orchestration for the Dashboard header "sync all" button and
 * the Creators directory refresh actions: full multi-channel refresh with
 * platform pacing, single-creator refresh and single-channel refresh
 * (cooldown guard, force-refresh limit). Wraps the `src/sync` layer only —
 * no database access here. UI text/messages are preserved verbatim.
 */
export function useSyncActions(deps: SyncActionsDependencies) {
  const isRefreshingAll = ref(false);
  const refreshProgress = ref<RefreshProgress>({ current: 0, total: 0 });

  // Refresh all channels using multi-round interleaved round-robin pacing across platforms
  async function handleRefreshAll(restoreDeleted: boolean = false) {
    if (isRefreshingAll.value || deps.getChannels().length === 0) return;
    isRefreshingAll.value = true;
    refreshProgress.value = { current: 0, total: deps.getChannels().length };

    try {
      const minDelay = Math.max(deps.getRequestDelayMs() || 600, 800);
      await batchUpdateChannelsInterleaved(
        deps.getChannels(),
        deps.getItemsPerFetch(),
        {
          onlyOriginal: deps.getHideReposts(),
          minPlatformIntervalMs: minDelay,
          restoreDeleted,
          onProgress: (current, total) => {
            refreshProgress.value = { current, total };
          },
        }
      );
      await deps.reloadData();
    } catch (err) {
      console.error('Refresh all error', err);
    } finally {
      isRefreshingAll.value = false;
      await clearStaleUpdatingStatus();
      await deps.reloadData();
    }
  }

  // Refresh single creator
  async function handleRefreshCreator(creatorId: string) {
    const creator = deps.getCreators().find(c => c.id === creatorId);
    const chs = deps.getChannels().filter(ch => ch.creatorId === creatorId);
    if (chs.length === 0) {
      alert('该创作者暂未绑定任何平台账号，请先点击【追加新账号】添加。');
      return;
    }
    const results = await updateCreator(creatorId, deps.getItemsPerFetch(), { onlyOriginal: deps.getHideReposts() });
    await deps.reloadData();
    const safeResults = Array.isArray(results) ? results : [];
    const totalPosts = safeResults.reduce((acc, r) => acc + (r.posts?.length || 0), 0);
    const errors = safeResults.filter(r => r.error).map(r => r.error);
    if (errors.length > 0 && totalPosts === 0) {
      alert(`【同步提示 - ${creator?.name || '创作者'}】\n${errors.join('\n')}`);
    } else {
      alert(`【同步完成】已成功获取到 ${totalPosts} 条作品/动态！`);
    }
  }

  // Refresh single channel (with optional forceRefresh to update existing posts)
  async function handleRefreshChannel(channel: Channel, forceRefresh: boolean = false) {
    // Prevent rapid spam-clicks (8s cooldown check unless forceRefresh)
    if (!forceRefresh && channel.lastCheckAt && Date.now() - channel.lastCheckAt < 8_000) {
      alert('【操作过于频繁】该账号在 8 秒内刚执行过同步。为保护账号免受平台限流，请稍等片刻后再试。');
      return;
    }
    const fetchLimit = forceRefresh ? 100 : deps.getItemsPerFetch();
    const res = await updateChannel(channel, fetchLimit, true, {
      onlyOriginal: deps.getHideReposts(),
      forceRefresh,
    });
    await deps.reloadData();
    if (res.error) {
      alert(`【同步未成功】${channel.displayName || channel.accountId}：\n${res.error}`);
    } else if (res.posts && res.posts.length > 0) {
      alert(`【同步成功】已获取并更新 ${channel.displayName || channel.accountId} 的 ${res.posts.length} 条作品/动态！`);
    } else {
      alert(`【同步完成】连接平台成功，但 ${channel.displayName || channel.accountId} 近期暂无公开发布的内容。`);
    }
  }

  /** Batch-refresh flow used by the Creators directory batch toolbar. */
  async function batchRefreshCreators(creatorIds: string[]) {
    if (creatorIds.length === 0) return;
    for (const id of creatorIds) {
      await handleRefreshCreator(id);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 600);
      await promise;
    }
    alert(`【批量同步完成】已成功同步选中的 ${creatorIds.length} 位创作者动态！`);
  }

  return {
    isRefreshingAll,
    refreshProgress,
    handleRefreshAll,
    handleRefreshCreator,
    handleRefreshChannel,
    batchRefreshCreators,
  };
}
