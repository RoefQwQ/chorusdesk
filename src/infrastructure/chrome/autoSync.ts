import type { Channel } from '../../types';
import { db } from '../db/database';
import { getSettings } from '../db/settingsRepository';
import { devLog } from '../../utils/devLog';
import { errorMessage } from '../../utils/errorMessage';
import { batchUpdateChannelsInterleaved } from '../../sync/batchSync';

const AUTO_SYNC_ALARM = 'creator-feed-auto-sync';
const AUTO_SYNC_PERIOD_MINUTES = 30;

/**
 * (Re)creates or clears the periodic auto-sync alarm according to the current
 * setting, then refreshes the unread badge. Safe to call on startup, install
 * or whenever the setting changes.
 *
 * `chrome.alarms.create` with an existing name REPLACES that alarm and restarts
 * its countdown, so an unconditional create here meant any service-worker wake
 * (opening the popup, any message) reset the 30-minute timer — with normal use
 * the alarm never fired at all. Dynamic alarms already persist across restarts,
 * so we only create when missing or when the period changed.
 */
export async function setupAutoSync() {
  if (!chrome.alarms) return;
  const settings = await getSettings();
  if (settings.enableAutoSync) {
    const existing = await chrome.alarms.get(AUTO_SYNC_ALARM);
    if (!existing || existing.periodInMinutes !== AUTO_SYNC_PERIOD_MINUTES) {
      await chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: AUTO_SYNC_PERIOD_MINUTES });
    }
  } else {
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
  }
  await updateUnreadBadge();
}

/**
 * Syncs every tracked channel once with the current per-fetch limit and
 * repost preference. No-op while auto-sync is disabled.
 *
 * Uses the same interleaved, per-platform-paced batch routine as the dashboard's
 * manual refresh rather than a bare serial loop: this path previously issued
 * back-to-back requests with no delay, which now matters because the requests
 * actually reach the network (see `src/infrastructure/chrome/http.ts`).
 */
async function syncAllChannels() {
  try {
    const settings = await getSettings();
    if (!settings.enableAutoSync) return;

    const channels: Channel[] = await db.channels.toArray();
    if (channels.length === 0) return;

    const summary = await batchUpdateChannelsInterleaved(channels, settings.itemsPerFetch, {
      onlyOriginal: settings.hideReposts,
      minPlatformIntervalMs: Math.max(settings.requestDelayMs ?? 0, 800),
    });
    // The alarm firing is already logged by the router (`devLog.info('alarm', ...)`),
    // but its OUTCOME was recorded nowhere: a user reporting 「后台自动更新好像没生效」
    // saw the trigger and then nothing, and the failure went to a console the panel
    // cannot read. These lines are the whole answer to that question.
    //
    // The batch's OWN accounting is reported, not the channel count. This line
    // read 「后台自动同步完成，渠道 N 个」 while discarding the result — so ten
    // channels failing ten times logged as a clean completion. That is the
    // 「操作完成 ≠ 业务成功」 shape the storage-failure fix was about, one layer up:
    // the run finished, the sync did not.
    const failed = summary.totalChannels - summary.successful;
    if (failed > 0) {
      devLog.warn(
        'autoSync',
        `后台自动同步完成（${failed}/${summary.totalChannels} 个频道未成功）`,
        `新增 ${summary.newPostsCount} 条；失败频道的行内会显示具体原因。`,
      );
    } else {
      devLog.info(
        'autoSync',
        '后台自动同步完成',
        `渠道 ${summary.totalChannels} 个全部成功，新增 ${summary.newPostsCount} 条`,
      );
    }
  } catch (error) {
    devLog.error('autoSync', '后台自动同步失败', errorMessage(error));
  }
}

/**
 * Reflects the unread post count on the toolbar badge (capped at 999, indigo).
 *
 * `isRead` is stored as 0|1 because IndexedDB refuses booleans as index keys
 * (see AGENTS.md rule 5); querying `equals(0)` against boolean-valued rows
 * matched nothing, which is why the badge used to stay empty.
 */
export async function updateUnreadBadge() {
  try {
    const unreadCount = await db.posts.where('isRead').equals(0).count();
    await chrome.action?.setBadgeText({ text: unreadCount > 0 ? String(Math.min(unreadCount, 999)) : '' });
    await chrome.action?.setBadgeBackgroundColor({ color: '#4f46e5' });
  } catch (error) {
    devLog.warn('autoSync', '未读角标更新失败', errorMessage(error));
  }
}

/**
 * Handler for the auto-sync alarm: clears the alarm when auto-sync is
 * disabled, otherwise syncs all channels and refreshes the badge.
 */
export async function handleAutoSyncAlarm(alarm: { name: string }) {
  if (!chrome.alarms) return;
  if (alarm.name !== AUTO_SYNC_ALARM) return;
  const settings = await getSettings();
  if (!settings.enableAutoSync) {
    // Clear alarm if auto sync is disabled
    await chrome.alarms.clear(AUTO_SYNC_ALARM);
    return;
  }
  await syncAllChannels();
  await updateUnreadBadge();
}
