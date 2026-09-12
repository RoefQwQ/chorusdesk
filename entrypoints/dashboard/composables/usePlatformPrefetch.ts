import { ref, type ShallowRef } from 'vue';
import type { Post } from '../../../src/types';
import { imageCacheService } from '../../../src/services/imageCache';
import { devLog } from '../../../src/utils/devLog';

/**
 * Hover-prefetch for the platform sidebar (queue B5, user-approved design).
 *
 * Hovering a platform row warms the first screen of that platform's images into
 * the local disk cache, so switching to it renders from disk instead of the
 * network. The measured premise: one screen is ~36 posts / ~12 MB.
 *
 * Design constraints, each earned:
 *
 *  - **Hover, not selection.** The point is to spend the network BEFORE the user
 *    commits, so the work must start on `mouseenter` and be cheap enough that an
 *    accidental pass costs little.
 *  - **Bounded and one-shot per platform.** A prefetch that re-runs on every
 *    re-hover turns a gesture into a background archiver; `done` is per-platform
 *    and never resets within a session, and only the FIRST screen is warmed.
 *  - **Silent.** This is an optimisation: it must never surface an error, block
 *    a click, or write a warning when the cache is unbound (the common case —
 *    disk caching is opt-in).
 *  - **Cancellable.** A quick pass across five rows must not stack five pools;
 *    a newer hover supersedes the older one.
 */

/** Media items to warm per hover: the measured first screen. */
const PREFETCH_POST_LIMIT = 36;

export function usePlatformPrefetch(posts: ShallowRef<Post[]>) {
  /** Platforms already warmed this session; never cleared (see the note above). */
  const prefetched = ref<Set<string>>(new Set());
  /** The device the current pass belongs to; a newer hover bumps it. */
  let generation = 0;

  /**
   * Warm `platform`'s first screen, if it has not been warmed already.
   *
   * Returns without doing anything when the disk cache is not available, which
   * is the default — `isReady()` is checked rather than attempted, so an
   * unbound cache costs one probe instead of N failed writes.
   */
  async function prefetchPlatform(platform: string): Promise<void> {
    if (prefetched.value.has(platform)) return;

    let ready = false;
    try {
      ready = (await imageCacheService.isReady()).ready;
    } catch {
      return;
    }
    if (!ready) return;

    const mine = ++generation;
    prefetched.value = new Set(prefetched.value).add(platform);

    const targets = posts.value.filter((p) => p.platform === platform).slice(0, PREFETCH_POST_LIMIT);
    if (targets.length === 0) return;

    let cached = 0;
    for (const post of targets) {
      // A newer hover took over: stop without touching the rest. The posts
      // already warming are left to finish — they are the same cache entries
      // the newer pass would have wanted.
      if (mine !== generation) return;
      try {
        const n = await imageCacheService.cachePost(post);
        if (n > 0) cached += n;
      } catch {
        // Best effort per post, like the batch archiver: one failure must not
        // abort the screen, and nothing here is worth a user-visible message.
      }
    }

    if (cached > 0) {
      devLog.debug('prefetch', `${platform} 首屏预取完成`, `已缓存 ${cached} 张（${targets.length} 条动态）`);
    }
  }

  return { prefetchPlatform, prefetchedPlatforms: prefetched };
}
