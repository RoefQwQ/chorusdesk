import type { Ref, ShallowRef } from 'vue';
import type { Creator, Channel, Post, AppSettings } from '../../../src/types';
import { db } from '../../../src/infrastructure/db/database';
import {
  getSettings,
  saveSettings as saveSettingsRecord,
} from '../../../src/infrastructure/db/settingsRepository';
import { getDatabaseStats } from '../../../src/infrastructure/db/statsService';
import { healBrokenPostMedia } from '../../../src/infrastructure/db/postRepository';
import { updateChannel } from '../../../src/sync';
import { channelService } from '../../../src/application';
import { useDashboardData } from './useDashboardData';
import type { DashboardStats } from './useDashboardData';

export interface DashboardShellState {
  creators: Ref<Creator[]>;
  channels: Ref<Channel[]>;
  posts: ShallowRef<Post[]>;
  dbStats: Ref<DashboardStats>;
  settings: Ref<AppSettings>;
  /** Feed reload (creators/channels/posts/stats + best-effort media healing). */
  reloadFeedData: () => Promise<void>;
  /** Load persisted settings into `settings`. */
  loadSettings: () => Promise<AppSettings>;
  /** Persist a partial settings patch, returning the merged settings. */
  saveSettings: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  /** Reset channels left in "updating" state (crash recovery). */
  clearStaleUpdatingStatus: () => Promise<void>;
  /** `updateChannel` with the same signature `src/sync` exposes. */
  updateChannel: typeof updateChannel;
  /** Ask the background worker to reconcile the auto-sync alarm. */
  notifyAutoSyncChanged: () => void;
}

/**
 * Dashboard infrastructure shell: the single construction site for the page's
 * db/settings/stats/repository/sync dependencies. Data loading composes the
 * existing `useDashboardData` loader with those dependencies injected, so no
 * loader logic is duplicated here. App.vue consumes only this shell — it never
 * imports db, Dexie repositories or sync functions itself.
 */
export function useDashboardShell(): DashboardShellState {
  const dashboardData = useDashboardData({
    db,
    getSettings,
    getDatabaseStats,
    healBrokenPostMedia,
  });
  const {
    creators,
    channels,
    posts,
    dbStats,
    settings,
    reloadData: reloadFeedData,
    loadSettings,
  } = dashboardData;

  async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = await saveSettingsRecord(patch);
    settings.value = next;
    return next;
  }

  /** Tell the background worker to (re)create or clear the auto-sync alarm. */
  function notifyAutoSyncChanged() {
    chrome.runtime?.sendMessage?.({ type: 'UPDATE_AUTO_SYNC' });
  }

  return {
    creators,
    channels,
    posts,
    dbStats,
    settings,
    reloadFeedData,
    loadSettings,
    saveSettings,
    clearStaleUpdatingStatus: () => channelService.clearStaleUpdatingStatus(),
    updateChannel,
    notifyAutoSyncChanged,
  };
}
