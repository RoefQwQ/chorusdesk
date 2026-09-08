import { ref } from 'vue';
import type { Creator, Channel } from '../../../src/types';
import { PLATFORM_REGISTRY } from '../../../src/types';
import { deepSyncChannel } from '../../../src/sync';
import type { DeepSyncStartRequest } from '../types/modal';

export interface DeepSyncDependencies {
  /** Live channel list — target channels are resolved from the request ids. */
  getChannels: () => Channel[];
  reloadData: () => Promise<void>;
}

/**
 * Deep history-sync orchestration for the Dashboard: owns the modal target,
 * running flag, progress/log state and drives `deepSyncChannel` per selected
 * channel. Pure orchestration — no repository or Dexie access here.
 */
export function useDeepSync(deps: DeepSyncDependencies) {
  const deepSyncTargetCreator = ref<Creator | null>(null);
  const deepSyncInitialChannelId = ref<string | undefined>(undefined);
  const isDeepSyncRunning = ref<boolean>(false);
  const deepSyncAbortRequested = ref<boolean>(false);
  const deepSyncLogs = ref<string[]>([]);
  const deepSyncTotalNew = ref<number>(0);
  const deepSyncCurrentStatus = ref<string>('');

  function openDeepSyncModal(creator: Creator, specificChannelId?: string) {
    deepSyncTargetCreator.value = creator;
    deepSyncInitialChannelId.value = specificChannelId;
    isDeepSyncRunning.value = false;
    deepSyncAbortRequested.value = false;
    deepSyncLogs.value = [];
    deepSyncTotalNew.value = 0;
    deepSyncCurrentStatus.value = '';
  }

  function closeDeepSyncModal() {
    deepSyncTargetCreator.value = null;
  }

  async function startDeepSync(request: DeepSyncStartRequest) {
    const creator = deepSyncTargetCreator.value;
    if (!creator || request.channelIds.length === 0) return;
    isDeepSyncRunning.value = true;
    deepSyncAbortRequested.value = false;
    deepSyncLogs.value = [];
    deepSyncTotalNew.value = 0;

    const targetChannels = deps.getChannels().filter(ch => request.channelIds.includes(ch.id));
    const maxPostsPerChannel = request.mode === 'count' ? request.targetCount : 0;
    const untilTimestamp = request.mode === 'time' && request.timeRange > 0
      ? Date.now() - request.timeRange * 24 * 60 * 60 * 1000
      : 0;

    let grandTotal = 0;

    for (const ch of targetChannels) {
      if (deepSyncAbortRequested.value) break;

      const chName = `${PLATFORM_REGISTRY[ch.platform]?.name || ch.platform} (@${ch.displayName || ch.accountId})`;
      deepSyncCurrentStatus.value = `正在深度回溯：${chName}...`;
      deepSyncLogs.value.unshift(`[开始回溯] ${chName}`);

      const res = await deepSyncChannel(ch, {
        maxPosts: maxPostsPerChannel,
        untilTimestamp,
        onlyOriginal: request.onlyOriginal,
        forceResetCursor: request.resetCursor,
        shouldStop: () => deepSyncAbortRequested.value,
        onProgress: (info) => {
          if (info.status === 'fetching' && info.fetchedThisRound > 0) {
            deepSyncLogs.value.unshift(`[${info.platform}] 第 ${info.round} 轮翻页抓取到 ${info.fetchedThisRound} 条更早动态 (累计 +${info.totalNewPosts})`);
            if (deepSyncLogs.value.length > 50) deepSyncLogs.value.pop();
          }
          if (info.error) {
            deepSyncLogs.value.unshift(`[提示] ${info.error.message}`);
          }
        }
      });

      grandTotal += res.totalNew;
      deepSyncTotalNew.value = grandTotal;
      deepSyncLogs.value.unshift(`[${chName}] 回溯完成，共取得 ${res.totalNew} 条更早作品${res.reachEnd ? ' (已抵达历史终点)' : ''}`);
      await deps.reloadData();
    }

    isDeepSyncRunning.value = false;
    deepSyncCurrentStatus.value = deepSyncAbortRequested.value ? '已中止抓取' : '全部选定渠道回溯完成！';
    await deps.reloadData();
  }

  function stopDeepSync() {
    deepSyncAbortRequested.value = true;
    deepSyncCurrentStatus.value = '正在安全停止当前请求...';
  }

  return {
    deepSyncTargetCreator,
    deepSyncInitialChannelId,
    isDeepSyncRunning,
    deepSyncAbortRequested,
    deepSyncLogs,
    deepSyncTotalNew,
    deepSyncCurrentStatus,
    openDeepSyncModal,
    closeDeepSyncModal,
    startDeepSync,
    stopDeepSync,
  };
}
