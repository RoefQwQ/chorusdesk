import { ref } from 'vue';
import type { Creator, Channel } from '../../../src/types';
import { PLATFORM_REGISTRY } from '../../../src/types';
import { deepSyncChannel } from '../../../src/sync';
import { digRisksUserAccount } from '../../../src/adapters/types';
import { getAdapter } from '../../../src/platform/registry';
import { dialog } from './useDialog';
import type { DeepSyncStartRequest } from '../types/modal';

export interface DeepSyncDependencies {
  /** Live channel list — target channels are resolved from the request ids. */
  getChannels: () => Channel[];
  reloadData: () => Promise<void>;
}

/**
 * How many risky accounts in one dig warrant the stronger wording.
 *
 * A dig scrolls the user's own logged-in page, and each account is a separate
 * burst of scroll traffic against a platform whose anti-bot heuristics watch for
 * exactly that. One account is the ordinary case the confirmation already covers;
 * three at once is a different shape of risk and is said plainly. This is a
 * wording threshold, not a gate — nothing is blocked.
 */
const RISKY_DIG_ACCOUNT_THRESHOLD = 3;

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

    const targetChannels = deps.getChannels().filter(ch => request.channelIds.includes(ch.id));

    // Warn BEFORE any acquisition, and only about platforms whose dig actually
    // drives the user's own page (`digScrollsUserPage`). The cost is paid by the
    // user's account, so it is their decision to make — the reference
    // implementation for the one such platform ships this behaviour off by
    // default, behind a risk warning of its own.
    const risky = targetChannels.filter(ch => digRisksUserAccount(getAdapter(ch.platform)));
    if (risky.length > 0) {
      const names = [...new Set(risky.map(ch => PLATFORM_REGISTRY[ch.platform]?.name || ch.platform))].join('、');
      const severe = risky.length >= RISKY_DIG_ACCOUNT_THRESHOLD;
      const confirmed = await dialog.confirm(
        `【回溯会滚动你的已登录页面】\n\n`
        + `本次回溯包含 ${names} 的 ${risky.length} 个账号。这些平台的历史动态只能在浏览器里`
        + `打开并滚动你的已登录页面才能取到，而连续滚动正是平台风控会留意的行为。\n\n`
        + (severe
          ? `一次回溯 ${risky.length} 个账号会让风控压力叠加。建议分批进行，` +
            `或改用较小的时间 / 数量范围。\n\n`
          : '')
        + `若平台弹出验证，请先在对应页面完成验证再重试；该平台随后会自动进入冷却。\n\n`
        + `继续回溯吗？`,
        { title: severe ? '回溯较大范围前的提醒' : '回溯前的提醒' },
      );
      if (!confirmed) {
        deepSyncLogs.value.unshift('[已取消] 你在提醒中选择了不继续。');
        return;
      }
    }

    isDeepSyncRunning.value = true;
    deepSyncAbortRequested.value = false;
    deepSyncLogs.value = [];
    deepSyncTotalNew.value = 0;

    const maxPostsPerChannel = request.mode === 'count' ? request.targetCount : 0;
    const untilTimestamp = request.mode === 'time' && request.timeRange > 0
      ? Date.now() - request.timeRange * 24 * 60 * 60 * 1000
      : 0;

    let grandTotal = 0;

    for (const ch of targetChannels) {
      if (deepSyncAbortRequested.value) break;

      const chName = `${PLATFORM_REGISTRY[ch.platform]?.name || ch.platform} (@${ch.displayName || ch.accountId})`;
      deepSyncCurrentStatus.value = `正在深度回溯：${chName}…`;
      deepSyncLogs.value.unshift(`[开始回溯] ${chName}`);

      const res = await deepSyncChannel(ch, {
        maxPosts: maxPostsPerChannel,
        untilTimestamp,
        onlyOriginal: request.onlyOriginal,
        forceResetCursor: request.resetCursor,
        shouldStop: () => deepSyncAbortRequested.value,
        onProgress: (info) => {
          if (info.status === 'fetching' && info.fetchedThisRound > 0) {
            deepSyncLogs.value.unshift(`[${info.platform}] 第 ${info.round} 轮翻页抓取到 ${info.fetchedThisRound} 条更早动态（累计 +${info.totalNewPosts}）`);
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
    deepSyncCurrentStatus.value = '正在安全停止当前请求…';
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
