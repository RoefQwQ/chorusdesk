import { ref, type Ref } from 'vue';
import type { Channel, Creator, Post } from '../../../src/types';
import { imageCacheService } from '../../../src/services/imageCache';
import { archivesMedia } from '../../../src/adapters/types';
import { getAdapter } from '../../../src/platform/registry';
import { devLog } from '../../../src/utils/devLog';

/**
 * Archive freshly-synced posts' media to disk, right after a sync.
 *
 * The user's requirement, verbatim: once the local save directory is set, a sync
 * should quietly save both the images and the post data — no extra step. Before
 * this, archiving only ever happened as a side effect of *rendering*: a card
 * autosaved when its image loaded, or the sidebar prefetched the first screen on
 * hover. So a post the user never scrolled to was never saved, and by the time
 * they did scroll to it the URL had often expired:
 *
 *   measured in a real library — a note published 5/21, synced 9/6, still showing
 *   「原图暂无法直接预览」, because 9/6 was the first time anything asked for the
 *   image and xiaohongshu's signed CDN link had already lapsed.
 *
 * That is the whole reason this exists: for a platform whose URLs expire, the only
 * chance to keep the image is the moment the sync hands it to us.
 *
 * ## Why it lives here, not in `src/sync`
 *
 * `channelSync` runs in the **service worker** for the alarm and popup paths, and
 * `fsManager` needs `window.showDirectoryPicker` — there is no `window` in a
 * worker, so archiving is impossible there. The dashboard's sync runs in the page,
 * so the pass belongs to the dashboard's post-sync step, which is where every
 * refresh handler already lands (`useSyncActions`).
 *
 * ## What it deliberately does NOT do
 *
 *  - **No dialog, no progress UI, no error surfaced.** The user asked for silent.
 *    A failure here is a cache miss, not a lost sync; the card still shows the
 *    network image and retries through its own path.
 *  - **No gate on `enableImageCache`.** That flag is written by the bind/unbind
 *    buttons but read by nothing (`ImageCacheSettings.vue` only sets it) — the real
 *    gate is whether a directory is bound, which `isReady()` answers. Adding a
 *    second, unread condition would be inventing state, not using it.
 *  - **It does not re-download what is already on disk.** `cacheMediaItem` checks
 *    the existing file first, so a re-run costs directory lookups, not network.
 */

/** Posts to archive per sync, newest first. A sync returns ~10-100; this caps a force refresh. */
const ARCHIVE_POST_LIMIT = 100;

export interface ArchiveDependencies {
  /** Newest-first candidate posts (the feed snapshot after the sync's reload). */
  getPosts: () => Post[];
  /** Creator directory names, so files land under the same folder the cards use. */
  getCreators: () => Creator[];
  getChannels: () => Channel[];
  /** `settings.imageCacheStrategy`; absent means 'all'. */
  getStrategy: () => 'all' | 'restricted_only' | 'bookmarks_only' | undefined;
}

/**
 * Platforms whose media URLs are signed and expire, i.e. the ones where "archive
 * now or lose it" actually applies.
 *
 * Declared by the adapter where possible: `archivesMedia: false` already marks the
 * platforms not worth saving (rss). This set is the other half — the ones where
 * saving is *urgent* — and `types.ts` names xiaohongshu as the example. Douyin
 * covers carry `x-expires`/`x-signature` the same way, so it belongs here too.
 *
 * Kept as a list rather than an adapter field because it is a hint for *when* to
 * save, not a capability: a platform may be worth archiving without being urgent.
 */
const EPHEMERAL_MEDIA_PLATFORMS: ReadonlySet<string> = new Set(['xiaohongshu', 'douyin']);

/** `settings.imageCacheStrategy`. Absent = 'all'. */
export type ArchiveStrategy = 'all' | 'restricted_only' | 'bookmarks_only';

export interface ArchiveDependencies {
  /** Newest-first candidate posts (the feed snapshot after the sync's reload). */
  getPosts: () => Post[];
  /** Creator directory names, so files land under the same folder the cards use. */
  getCreators: () => Creator[];
  getChannels: () => Channel[];
  /** `settings.imageCacheStrategy`; absent means 'all'. */
  getStrategy: () => ArchiveStrategy | undefined;
}

/**
 * Post-sync media archiving: one pass per sync, over the posts the snapshot
 * already holds, in the page context where the File System Access API exists.
 */
export function usePostSyncArchive(deps: ArchiveDependencies) {
  /** A run is in flight; a second sync must not stack a parallel pass. */
  const archiving = ref(false);
  /** Set once a pass has found no bound directory, so we stop probing every sync. */
  let unbound = false;

  /**
   * Which posts this pass should save, given the user's strategy.
   *
   * `restricted_only` is the reason the setting exists: saving is only *necessary*
   * for expiring URLs, and archiving a large library of permanent ones is a lot of
   * disk for nothing. `bookmarks_only` keeps the archive to what the user flagged.
   */
  function selectPosts(strategy: ArchiveStrategy | undefined): Post[] {
    const mode = strategy ?? 'all';
    return deps
      .getPosts()
      .filter((p) => p.mediaList?.length > 0)
      .filter((p) => {
        if (mode === 'bookmarks_only') return Boolean(p.isBookmarked);
        if (mode === 'restricted_only') return EPHEMERAL_MEDIA_PLATFORMS.has(p.platform);
        return true;
      })
      .filter((p) => archivesMedia(getAdapter(p.platform)))
      .slice(0, ARCHIVE_POST_LIMIT);
  }

  /** The creator's display name, so the folder matches what the cards write. */
  function creatorNameFor(post: Post): string | undefined {
    const creator = deps.getCreators().find((c) => c.id === post.creatorId);
    if (creator?.name) return creator.name;
    const channel = deps.getChannels().find((c) => c.id === post.channelId);
    return channel?.displayName;
  }

  /**
   * Run one archiving pass. Never throws and never blocks the caller's UI: the
   * caller `await`s it only to keep ordering tidy, and a rejection inside is
   * swallowed per post.
   */
  async function archiveSyncedPosts(): Promise<void> {
    if (unbound || archiving.value) return;
    // Claim the slot BEFORE the first await. The readiness probe below yields, so
    // checking `archiving` up front and setting it afterwards let two syncs that
    // landed together both pass the check and save the same posts twice.
    archiving.value = true;

    try {
      let ready = false;
      try {
        ready = (await imageCacheService.isReady()).ready;
      } catch {
        return;
      }
      // No directory bound: the common case, and the reason this is silent.
      // Remember it for the session so each sync does not re-probe.
      if (!ready) {
        unbound = true;
        return;
      }

      const posts = selectPosts(deps.getStrategy());
      if (posts.length === 0) return;

      const started = Date.now();
      let images = 0;
      let completedPosts = 0;
      for (const post of posts) {
        try {
          const saved = await imageCacheService.cachePost(post, creatorNameFor(post));
          if (saved > 0) {
            images += saved;
            completedPosts++;
          }
        } catch {
          // Per post: one unreadable URL must not abandon the rest of the pass.
        }
      }

      // One summary line, not one per post (AGENTS rule 20). `debug` because this
      // is a success path on every sync; shown only with verbose on.
      if (images > 0) {
        devLog.debug(
          'imageCache',
          `同步后归档 ${images} 张（${completedPosts}/${posts.length} 条动态），耗时 ${Date.now() - started}ms`,
          '已保存到本地目录，后续离线可读',
        );
      }
    } finally {
      archiving.value = false;
    }
  }

  return { archiveSyncedPosts, archiving: archiving as Ref<boolean> };
}
