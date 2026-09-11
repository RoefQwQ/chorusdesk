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

  async function reloadData(): Promise<void> {
    try {
      await deps.healBrokenPostMedia();
    } catch {
      // Media healing is best effort and must not prevent feed loading.
    }

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
