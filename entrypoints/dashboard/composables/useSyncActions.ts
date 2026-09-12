import { ref } from 'vue';
import type { Creator, Channel } from '../../../src/types';
import { updateChannel, updateCreator, batchUpdateChannelsInterleaved } from '../../../src/sync';
import { channelService } from '../../../src/application';
import { originPattern, requestHostAccess } from '../../../src/infrastructure/chrome/optionalHostAccess';
import { devLog } from '../../../src/utils/devLog';
import { errorMessage } from '../../../src/utils/errorMessage';
import { dialog } from './useDialog';

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
 * RSS feeds live on arbitrary hosts, so they are the one platform that needs a
 * runtime host grant (see `optionalHostAccess.ts`). Called first thing in each
 * refresh handler: Chrome consumes the user gesture on the first
 * `permissions.request`, and it must not be spent on anything else.
 *
 * Non-RSS channels need no grant — their hosts are covered by `host_permissions`.
 */
async function ensureRssHostAccess(channels: Channel[]): Promise<boolean> {
  const feeds = channels.filter((ch) => ch.platform === 'rss');
  if (feeds.length === 0) return true;

  const granted = await requestHostAccess(feeds.map((ch) => ch.profileUrl));
  devLog.info(
    'hostAccess',
    granted ? `RSS 站点授权已确认（${feeds.length} 个源）` : `RSS 站点授权被拒绝（${feeds.length} 个源）`,
    feeds.map((ch) => originPattern(ch.profileUrl) || ch.platform).join(', '),
  );
  if (!granted) {
    await dialog.alert(
      '【需要站点访问权限】RSS 源不在扩展的固定平台清单内，需要你为该站点授权后才能抓取。\n\n'
      + '已跳过本次 RSS 同步；其余平台不受影响。再次点击同步可重新弹出授权提示。',
    );
  }
  return granted;
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
  const syncingCreatorIds = ref<Set<string>>(new Set());
  const syncingChannelIds = ref<Set<string>>(new Set());

  // Refresh all channels using multi-round interleaved round-robin pacing across platforms
  async function handleRefreshAll(restoreDeleted: boolean = false) {
    if (isRefreshingAll.value || deps.getChannels().length === 0) return;
    // First call in the handler: it needs the click's gesture token.
    const rssGranted = await ensureRssHostAccess(deps.getChannels());
    // A refused RSS grant drops those channels, so the progress total must be
    // the list actually handed to the batch, not the pre-filter count.
    const channels = rssGranted
      ? deps.getChannels()
      : deps.getChannels().filter((ch) => ch.platform !== 'rss');
    isRefreshingAll.value = true;
    refreshProgress.value = { current: 0, total: channels.length };

    try {
      const minDelay = Math.max(deps.getRequestDelayMs() || 600, 800);
      // The run had no header and no summary: the log showed a dozen channel
      // lines and nothing that said which run they belonged to or how it ended.
      // Both are borrowed from the batch's own return value, which this call
      // used to discard — so "10 channels, 10 failed" was indistinguishable from
      // a clean run in the log, even though the batch had already computed it.
      devLog.info(
        'sync',
        `开始刷新全部：${channels.length} 个频道`,
        `每平台间隔 ≥${minDelay}ms，每次 ${deps.getItemsPerFetch()} 条${restoreDeleted ? '，含恢复已删' : ''}`,
      );
      const runStarted = Date.now();
      const summary = await batchUpdateChannelsInterleaved(
        channels,
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
      // Report the batch's own accounting rather than a bare 「完成」.
      // `successful` counts channels that returned content or no error; the
      // difference is what tells the user whether to look at the rows.
      const failed = summary.totalChannels - summary.successful;
      const line = `刷新全部结束：${summary.totalChannels} 个频道，成功 ${summary.successful}，失败 ${failed}，新增 ${summary.newPostsCount} 条，耗时 ${Date.now() - runStarted}ms`;
      if (failed > 0) devLog.warn('sync', line, '失败频道的行内会显示具体原因');
      else devLog.info('sync', line);
      await deps.reloadData();
    } catch (err) {
      // This catch used to do nothing but `console.error`, which the Developer Log
      // panel cannot read. A per-channel failure already has a visible signal (the
      // row's 同步失败 badge, written by channelSync), so the case that was silent is
      // this one: the batch call ITSELF throwing — a harness-level fault, where the
      // spinner simply stopped with no explanation anywhere.
      //
      // Recorded in the log rather than given new UI state: the per-channel badge
      // already covers what the user can act on, and inventing a second error
      // surface for a fault that means "reload the extension" would be noise.
      devLog.error('sync', '刷新全部失败', errorMessage(err, '刷新全部失败'));
    } finally {
      isRefreshingAll.value = false;
      await channelService.clearStaleUpdatingStatus();
      await deps.reloadData();
    }
  }

  // Refresh single creator
  async function handleRefreshCreator(creatorId: string) {
    const creator = deps.getCreators().find(c => c.id === creatorId);
    const chs = deps.getChannels().filter(ch => ch.creatorId === creatorId);
    if (chs.length === 0) {
      await dialog.alert('该创作者暂未绑定任何平台账号，请先点击【追加新账号】添加。');
      return;
    }
    // First call in the handler: it needs the click's gesture token.
    if (!(await ensureRssHostAccess(chs))) return;
    syncingCreatorIds.value.add(creatorId);
    syncingCreatorIds.value = new Set(syncingCreatorIds.value);
    try {
      const results = await updateCreator(creatorId, deps.getItemsPerFetch(), { onlyOriginal: deps.getHideReposts() });
      await deps.reloadData();
      const safeResults = Array.isArray(results) ? results : [];
      const totalPosts = safeResults.reduce((acc, r) => acc + (r.posts?.length || 0), 0);
      const rawFetched = safeResults.reduce((acc, r) => acc + (r.totalFetched || 0), 0);
      const errors = safeResults
        .filter(r => r.error)
        .map(r => r.error!.message);
      if (errors.length > 0 && totalPosts === 0) {
        await dialog.alert(`【同步提示 - ${creator?.name || '创作者'}】\n${errors.join('\n')}`);
      } else if (totalPosts === 0 && rawFetched > 0 && deps.getHideReposts()) {
        // The platform did return content and none of it was new-to-us *after*
        // the retweet filter. Saying "已成功获取到 0 条" here reads as a failure
        // for a creator whose feed is mostly retweets.
        await dialog.alert(
          `【同步完成】${creator?.name || '创作者'} 近期没有新的原创动态。\n\n`
          + `平台返回了 ${rawFetched} 条内容，但当前开启了「默认隐藏转发」，其中没有符合条件的原创。`
          + `如需查看转发内容，可在设置页关闭「默认隐藏转发」后重试。`,
        );
      } else {
        await dialog.alert(`【同步完成】已成功获取到 ${totalPosts} 条作品/动态！`);
      }
    } finally {
      syncingCreatorIds.value.delete(creatorId);
      syncingCreatorIds.value = new Set(syncingCreatorIds.value);
    }
  }

  // Refresh single channel (with optional forceRefresh to update existing posts)
  async function handleRefreshChannel(channel: Channel, forceRefresh: boolean = false) {
    // First call in the handler: it needs the click's gesture token.
    if (!(await ensureRssHostAccess([channel]))) return;
    // Prevent rapid spam-clicks (8s cooldown check unless forceRefresh)
    if (!forceRefresh && channel.lastCheckAt && Date.now() - channel.lastCheckAt < 8_000) {
      await dialog.alert('【操作过于频繁】该账号在 8 秒内刚执行过同步。为保护账号免受平台限流，请稍等片刻后再试。');
      return;
    }
    syncingChannelIds.value.add(channel.id);
    syncingChannelIds.value = new Set(syncingChannelIds.value);
    try {
      const fetchLimit = forceRefresh ? 100 : deps.getItemsPerFetch();
      const res = await updateChannel(channel, fetchLimit, true, {
        onlyOriginal: deps.getHideReposts(),
        forceRefresh,
      });

      if (res.error) {
        await dialog.alert(`【同步未成功】${channel.displayName || channel.accountId}：\n${res.error.message}`);
      } else if (res.posts && res.posts.length > 0) {
        await dialog.alert(`【同步成功】已获取并更新 ${channel.displayName || channel.accountId} 的 ${res.posts.length} 条作品/动态！`);
      } else if ((res.totalFetched || 0) > 0 && deps.getHideReposts()) {
        // Same distinction as the creator-level flow: content came back but the
        // retweet filter removed all of it. "暂无公开发布的内容" would be wrong.
        await dialog.alert(
          `【同步完成】${channel.displayName || channel.accountId} 近期没有新的原创动态。\n\n`
          + `平台返回了 ${res.totalFetched} 条内容，但当前开启了「默认隐藏转发」，其中没有符合条件的原创。`,
        );
      } else {
        await dialog.alert(`【同步完成】连接平台成功，但 ${channel.displayName || channel.accountId} 近期暂无公开发布的内容。`);
      }
    } finally {
      syncingChannelIds.value.delete(channel.id);
      syncingChannelIds.value = new Set(syncingChannelIds.value);
      // The DB row changed (status, errorMessage, counters, posts) but the
      // rendered lists are still the previous snapshot. Without this reload a
      // successful sync left the channel's old「同步失败」badge and error text
      // on screen until the page was refreshed by hand — and a *new* failure
      // was equally invisible.
      await deps.reloadData();
    }
  }

  /** Batch-refresh flow used by the Creators directory batch toolbar. */
  async function batchRefreshCreators(creatorIds: string[]) {
    if (creatorIds.length === 0) return;
    // One gesture covers every selected RSS feed; the per-creator calls below
    // then re-request already-granted origins, which resolves without a prompt.
    const feeds = deps.getChannels()
      .filter((ch) => creatorIds.includes(ch.creatorId) && ch.platform === 'rss')
      .map((ch) => ch.profileUrl);
    await requestHostAccess(feeds);

    for (const id of creatorIds) {
      await handleRefreshCreator(id);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 600);
      await promise;
    }
    await dialog.alert(`【批量同步完成】已成功同步选中的 ${creatorIds.length} 位创作者动态！`);
  }

  return {
    isRefreshingAll,
    refreshProgress,
    syncingCreatorIds,
    syncingChannelIds,
    handleRefreshAll,
    handleRefreshCreator,
    handleRefreshChannel,
    batchRefreshCreators,
  };
}
