import { ref, shallowRef, type Ref, type ShallowRef } from 'vue';
import type { Channel, Creator, Post, AppSettings } from '../../../src/types';
import type { FeedDatabase } from '../../../src/infrastructure/db/database';

export interface DashboardStats {
  creatorsCount: number;
  channelsCount: number;
  totalPostsCount: number;
  bookmarkedPostsCount: number;
  storageUsageBytes: number;
  storageQuotaBytes: number;
}

interface DashboardDataDependencies {
  db: FeedDatabase;
  getSettings: () => Promise<AppSettings>;
  getDatabaseStats: () => Promise<DashboardStats>;
  healBrokenPostMedia: () => Promise<number>;
}

export interface DashboardDataState {
  creators: Ref<Creator[]>;
  channels: Ref<Channel[]>;
  posts: ShallowRef<Post[]>;
  dbStats: Ref<DashboardStats>;
  settings: Ref<AppSettings>;
  reloadData: () => Promise<void>;
  loadSettings: () => Promise<AppSettings>;
}

/**
 * Has this install already run the one-time media repair?
 *
 * Module scope, not a component ref: the dashboard is the only caller and it must
 * not run the pass again after a hot reload or a remount, and two rapid reloads
 * must not start two full table scans. Reset only by a page reload, which is
 * exactly the lifetime the flag needs.
 */
let mediaHealingDone = false;
/** In-flight pass, so concurrent reloads share one instead of racing. */
let mediaHealingInFlight: Promise<void> | undefined;

export function useDashboardData(deps: DashboardDataDependencies): DashboardDataState {
  const creators = ref<Creator[]>([]);
  const channels = ref<Channel[]>([]);
  const posts = shallowRef<Post[]>([]);
  const dbStats = ref<DashboardStats>({
    creatorsCount: 0,
    channelsCount: 0,
    totalPostsCount: 0,
    bookmarkedPostsCount: 0,
    storageUsageBytes: 0,
    storageQuotaBytes: 0,
  });
  const settings = ref<AppSettings>({
    theme: 'system',
    itemsPerFetch: 10,
    requestDelayMs: 600,
    autoOpenOriginalUrl: false,
  });

  async function loadSettings(): Promise<AppSettings> {
    const next = await deps.getSettings();
    settings.value = next;
    return next;
  }

  /**
   * Run the media repair at most once per page lifetime, in the background.
   *
   * Deliberately NOT awaited by `reloadData`: the repair is maintenance, and the
   * feed must render whether or not it has finished. `void`-ed on purpose.
   */
  function runMediaHealingOnce(): Promise<void> {
    if (mediaHealingDone) return Promise.resolve();
    if (mediaHealingInFlight) return mediaHealingInFlight;
    mediaHealingInFlight = (async () => {
      try {
        const healed = await deps.healBrokenPostMedia();
        // Flip only on success: a failure (a torn-down worker, a quota error)
        // must be retried on the next start rather than silently abandoned,
        // because the repair is the only thing that fixes those rows.
        mediaHealingDone = true;
        void healed;
      } catch {
        // Best effort, and must never prevent the feed from loading.
      } finally {
        mediaHealingInFlight = undefined;
      }
    })();
    return mediaHealingInFlight;
  }

  async function reloadData(): Promise<void> {
    // Media healing used to run HERE, on every reload — a full `posts.toArray()`
    // plus a `toSecureMediaUrl` per row, before the data the reload actually
    // wanted. This function is the dashboard's hot path: it runs after every
    // sync, every filter change and every write, so that repair was a tax paid
    // on each of them, and it grew with the library.
    //
    // It is a MIGRATION, not a read-path concern: it exists to fix rows an older
    // build wrote with `http://` or protocol-relative URLs, and once every row is
    // correct it can never find anything again. So it runs once per install
    // rather than once per reload, and the Settings panel keeps the manual entry
    // (`useMediaMaintenance`) for a library that grows into needing it.
    //
    // Guarded by a flag rather than simply removed: a user upgrading from a build
    // that wrote broken URLs still needs the repair, and it would never run if
    // this were deleted outright. The flag flips only after a successful pass, so
    // a failure is retried on the next start instead of being forgotten.
    // Awaited ONLY until it has run once. On the first reload of a page load it
    // must finish before the rows are read, or a repaired URL would not reach
    // the screen until the next reload (and the pass is once-per-page, so that
    // could be a long time). After that the flag short-circuits and this costs
    // nothing — which is the whole point of the change: the scan is paid once
    // per page load, not once per reload.
    if (!mediaHealingDone) await runMediaHealingOnce();

    creators.value = await deps.db.creators.toArray();
    channels.value = await deps.db.channels.toArray();
    posts.value = await deps.db.posts.orderBy('publishedAt').reverse().toArray();

    try {
      dbStats.value = await deps.getDatabaseStats();
    } catch {
      // Statistics are secondary to the feed itself.
    }

  }

  return { creators, channels, posts, dbStats, settings, reloadData, loadSettings };
}
