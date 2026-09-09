import Dexie from 'dexie';
import type { Creator, Channel, Post } from '../types';
import type { FetchError, FetchOptions, FetchResult } from '../adapters/types';
import { fetchError } from '../adapters/types';
import { getAdapter } from '../platform/registry';
import { db } from '../infrastructure/db/database';

/**
 * Resets any channels that were left in 'updating' status due to browser restart or crash.
 */
export async function clearStaleUpdatingStatus() {
  try {
    await db.channels.where('status').equals('updating').modify({
      status: 'idle',
    });
  } catch (e) {
    console.warn('[Adapters] Failed to clear stale updating status:', e);
  }
}
class FetchTimeoutError extends Error {}


/**
 * Friendly wording for error classes the sync layer understands. With the
 * structured FetchError contract this is a code lookup, not message regexing.
 */
function friendlyError(err: FetchError): string {
  switch (err.code) {
    case 'rate_limit':
      return '触发平台防刷频率限制。目标平台正在进行安全限流冷却，请等待 2~3 分钟后再刷新，避免频繁请求。';
    case 'auth':
      return err.message; // adapters already word auth errors as user actions
    default:
      return err.message;
  }
}

/**
 * Executes an on-demand update for a single channel with timeout safety & rate-limiting protection.
 */
export async function updateChannel(
  channel: Channel,
  limit: number = 10,
  force: boolean = false,
  options?: FetchOptions
): Promise<FetchResult> {
  const adapter = getAdapter(channel.platform);
  if (!adapter) {
    return { posts: [], error: fetchError('unsupported', `不支持的平台: ${channel.platform}`) };
  }

  // Cooldown protection: if updated successfully within 30 seconds and not forced, skip hitting network
  if (!force && !options?.cursor && channel.lastSuccessAt && Date.now() - channel.lastSuccessAt < 30_000) {
    return {
      posts: [],
      error: undefined,
    };
  }

  // Set updating status
  await db.channels.update(channel.id, {
    status: 'updating',
    errorMessage: undefined,
  });

  try {
    // Twitter may need an existing authenticated tab fallback; allow enough time for it to load.
    const timeoutPromise = new Promise<FetchResult>((_, reject) => {
      setTimeout(() => reject(new FetchTimeoutError('同步请求超时（已超过 45 秒未响应，请检查平台登录状态）')), 45_000);
    });

    // For normal (non-paginated) syncs, find the newest post already in DB to use as a watermark.
    // This tells adapters to only return content *newer* than what we already have.
    // When restoreDeleted, forceRefresh, cursor, or isHistory is true, bypass sinceTimestamp.
    let sinceTimestamp = options?.sinceTimestamp ?? 0;
    if (
      !sinceTimestamp &&
      !options?.cursor &&
      !options?.isHistory &&
      !options?.restoreDeleted &&
      !options?.forceRefresh
    ) {
      try {
        // [channelId+publishedAt] compound index: `.last()` walks the index
        // cursor straight to the newest post instead of materializing every
        // row of the channel (`.sortBy` loaded the whole channel into memory
        // on every normal sync).
        const latestPost = await db.posts
          .where('[channelId+publishedAt]')
          .between(
            [channel.id, Dexie.minKey],
            [channel.id, Dexie.maxKey]
          )
          .last();
        if (latestPost) {
          sinceTimestamp = latestPost.publishedAt;
        }
      } catch {}
    }

    const mergedOptions: FetchOptions = { ...options, sinceTimestamp };
    const result = await Promise.race([adapter.fetchLatest(channel, limit, mergedOptions), timeoutPromise]);

    if (result.error && result.posts.length === 0) {
      // End-of-history is signalled by hasMore === false or a not_found code,
      // never by message wording.
      if (result.hasMore === false || result.error.code === 'not_found') {
        await db.channels.update(channel.id, {
          status: 'success',
          nextCursor: '__END__',
          errorMessage: undefined,
          lastCheckAt: Date.now(),
          lastSuccessAt: Date.now(),
        });
        return { ...result, error: undefined };
      }

      const friendly = friendlyError(result.error);
      await db.channels.update(channel.id, {
        status: 'error',
        errorMessage: friendly,
        lastCheckAt: Date.now(),
      });
      return { ...result, error: { ...result.error, message: friendly } };
    }

    let enhancedPosts: Post[] = [];

    // Save or upsert posts (ensure channelLabel is populated)
    if (result.posts && result.posts.length > 0) {
      // Universal incremental filter:
      // 1. Force refresh: upsert all posts to heal media/content
      // 2. History dig (isHistory or cursor): upsert duplicates quietly to heal media, only add new IDs
      // 3. Normal sync (sinceTimestamp > 0): drop posts where publishedAt <= sinceTimestamp
      let newPosts = result.posts;
      if (options?.forceRefresh) {
        // When force-refreshing, do not filter out existing posts; upsert them all to heal media/content
      } else if (options?.isHistory || options?.cursor !== undefined) {
        try {
          // Use primaryKeys() instead of toArray() to avoid pulling full object payloads into memory
          const existingIds = new Set(
            await db.posts.where('channelId').equals(channel.id).primaryKeys()
          );
          // Quietly upsert existing posts to ensure their media and details are fresh/healed
          const duplicatePosts = result.posts.filter(p => existingIds.has(p.id));
          if (duplicatePosts.length > 0) {
            // bulkGet keeps order aligned with duplicatePosts; a miss (or a
            // read failure) simply means no regression guard for that row.
            let existingRows: (Post | undefined)[] = [];
            try {
              existingRows = await db.posts.bulkGet(duplicatePosts.map(p => p.id));
            } catch {}
            await db.posts.bulkPut(duplicatePosts.map((p, i) => {
              // Never regress an enriched media list: adapter detail-fetch
              // enrichment is capped per round (risk control), so a later
              // adapter round may return only the profile cover for a post
              // whose DB row already holds the full image set. More media wins.
              const existing = existingRows[i];
              if (existing && existing.mediaList.length > p.mediaList.length) {
                return {
                  ...p,
                  mediaList: existing.mediaList,
                  channelLabel: p.channelLabel || channel.label,
                };
              }
              return { ...p, channelLabel: p.channelLabel || channel.label };
            }));
          }
          newPosts = result.posts.filter(p => !existingIds.has(p.id));
          // History-dig budget: only genuinely new ids consume the quota.
          // Duplicates are upserted above (healing) without counting toward
          // it, so a re-run dig over an already-fetched window costs nothing.
          if (options?.maxNewPosts && options.maxNewPosts > 0) {
            newPosts = newPosts.slice(0, options.maxNewPosts);
          }
        } catch {}
      } else if (sinceTimestamp > 0) {
        newPosts = result.posts.filter(p => p.publishedAt > sinceTimestamp);
      }

      // Filter out deleted posts by default; if restoreDeleted is true, clear them from deletedPostIds
      if (!options?.restoreDeleted) {
        try {
          // channelId index on deletedPostIds — a full-table primaryKeys() scan
          // walked every tombstone in the database for each channel sync.
          const deletedKeys = await db.deletedPostIds
            .where('channelId')
            .equals(channel.id)
            .primaryKeys();
          if (deletedKeys.length > 0) {
            const deletedSet = new Set(deletedKeys);
            newPosts = newPosts.filter(p => !deletedSet.has(p.id));
          }
        } catch {}
      } else {
        try {
          const fetchedIds = newPosts.map(p => p.id);
          if (fetchedIds.length > 0) {
            await db.deletedPostIds.bulkDelete(fetchedIds);
          }
        } catch {}
      }

      enhancedPosts = newPosts.map((p) => ({
        ...p,
        channelLabel: p.channelLabel || channel.label,
      }));

      if (enhancedPosts.length > 0) {
        await db.posts.bulkPut(enhancedPosts);
      }

      // Bilibili dedup cleanup: remove any old bilibili_<dynId> posts that share
      // the same originalUrl as a freshly saved bilibili_video_<bvid> post.
      if (channel.platform === 'bilibili') {
        const videoUrls = new Set(
          enhancedPosts
            .filter(p => p.id.startsWith('bilibili_video_'))
            .map(p => p.originalUrl)
        );
        if (videoUrls.size > 0) {
          // Stream the channel's rows and collect only stale ids — never
          // materialize the whole channel as an array like the old toArray()
          // did. originalUrl is not indexed so rows must be read, but the
          // cursor is still bounded to this channel by the channelId index.
          const staleIds: string[] = [];
          await db.posts
            .where('channelId')
            .equals(channel.id)
            .each((p) => {
              if (!p.id.startsWith('bilibili_video_') && videoUrls.has(p.originalUrl)) {
                staleIds.push(p.id);
              }
            });
          if (staleIds.length > 0) {
            await db.posts.bulkDelete(staleIds);
          }
        }
      }
    }

    // Update channel metadata if updated
    const updates: Partial<Channel> = {
      status: 'success',
      lastCheckAt: Date.now(),
      lastSuccessAt: Date.now(),
      errorMessage: undefined,
    };

    // Cursor handling:
    // When doing a historical dig (isHistory or cursor is present):
    if (options?.isHistory || options?.cursor !== undefined) {
      if (result.nextCursor) {
        updates.nextCursor = result.nextCursor;
      } else if (result.hasMore === false) {
        updates.nextCursor = '__END__';
      }
    } else if (options?.forceRefresh) {
      // On force-refresh, update nextCursor to whatever fresh state was returned
      updates.nextCursor = result.nextCursor || undefined;
    } else {
      // Normal sync (fetching latest):
      // Only set nextCursor if channel currently has no cursor at all.
      // NEVER overwrite an already advanced historical cursor with page 1's cursor!
      if (result.nextCursor && !channel.nextCursor) {
        updates.nextCursor = result.nextCursor;
      }
    }

    if (result.authorMeta?.name) {
      const authName = result.authorMeta.name.trim();
      const currentName = channel.displayName || '';
      const isPlaceholderName =
        !currentName ||
        currentName === channel.accountId ||
        currentName === channel.accountId.replace(/^@/, '') ||
        currentName === `@${channel.accountId.replace(/^@/, '')}` ||
        currentName.startsWith(channel.platform) ||
        currentName.startsWith('Channel_') ||
        currentName.startsWith('B站') ||
        currentName.startsWith('小红书') ||
        currentName.startsWith('微博') ||
        currentName.startsWith('抖音') ||
        currentName.startsWith('Pixiv') ||
        currentName.startsWith('Fantia');

      if (isPlaceholderName && authName) {
        updates.displayName = authName;
      }
    }
    // Always update avatarUrl on channel (not just when empty, to stay fresh)
    if (result.authorMeta?.avatar) {
      updates.avatarUrl = result.authorMeta.avatar;
    }

    await db.channels.update(channel.id, updates);

    // Propagate avatar & authoritative name to parent Creator if Creator has default/placeholder info
    if (channel.creatorId) {
      const creator = await db.creators.get(channel.creatorId);
      if (creator) {
        const creatorUpdates: Partial<Creator> = {};
        // Update Creator avatar if empty, invalid, or updated
        if (result.authorMeta?.avatar && (!creator.avatar || creator.avatar.trim() === '' || creator.avatar.startsWith('http://'))) {
          creatorUpdates.avatar = result.authorMeta.avatar;
        }
        if (result.authorMeta?.name) {
          const authName = result.authorMeta.name.trim();
          const isDefaultCreatorName =
            !creator.name ||
            creator.name === '新创作者' ||
            creator.name === '未命名创作者' ||
            creator.name === channel.accountId ||
            creator.name === channel.accountId.replace(/^@/, '') ||
            creator.name.startsWith('Channel_') ||
            creator.name.startsWith('B站用户_') ||
            creator.name.startsWith('B站稿件_') ||
            creator.name.startsWith('小红书_') ||
            creator.name.startsWith('微博_') ||
            creator.name.startsWith('抖音用户_') ||
            creator.name.startsWith('抖音作品_') ||
            creator.name.startsWith('Pixiv画师_') ||
            creator.name.startsWith('Fantia俱乐部_');

          if (isDefaultCreatorName && authName) {
            creatorUpdates.name = authName;
          }
        }
        if (Object.keys(creatorUpdates).length > 0) {
          creatorUpdates.updatedAt = Date.now();
          await db.creators.update(channel.creatorId, creatorUpdates);
        }
      }
    }

    // Return the genuinely newly discovered posts so caller alerts reflect actual new content
    return {
      ...result,
      posts: enhancedPosts,
      totalFetched: result.posts?.length || 0,
    };
  } catch (err: unknown) {
    const structured = err instanceof FetchTimeoutError
      ? fetchError('timeout', err.message)
      : err instanceof Error
        ? fetchError('network', err.message, true)
        : fetchError('network', '未知异常', true);
    await db.channels.update(channel.id, {
      status: 'error',
      errorMessage: structured.message,
      lastCheckAt: Date.now(),
    });
    return { posts: [], error: structured };
  } finally {
    // Failsafe: Ensure channel is NEVER left in 'updating' status
    const current = await db.channels.get(channel.id);
    if (current?.status === 'updating') {
      await db.channels.update(channel.id, { status: 'idle' });
    }
  }
}
