import Dexie from 'dexie';
import type { Creator, Channel, Post } from '../types';
import type { FetchError, FetchOptions, FetchResult } from '../adapters/types';
import { fetchError } from '../adapters/types';
import { getAdapter } from '../platform/registry';
import { db } from '../infrastructure/db/database';
import { devLog } from '../utils/devLog';

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
 * An RSS row whose stored body is a summary where the feed has a full article.
 *
 * The adapter used to read `<description>`, which many feeds truncate themselves.
 * Rows written then are short; the freshly parsed body comes from
 * `<content:encoded>` and is the article. "The freshly parsed body is strictly
 * longer" is therefore the whole test — and it is self-limiting: once the row is
 * replaced, both sides come from the same source and are equal, so it never
 * matches again.
 *
 * An earlier version of this rule keyed off "stored length is exactly 353 and
 * ends with `...`" — the fingerprint of an old 350-character cap. That rule never
 * matched a single row in practice, because the data on disk was the feed's own
 * summary (measured 359 characters ending in a single `…`), not the cap's output.
 * The assumption, not the data, was wrong.
 */
export function isRssBodySuperseded(stored: Post, fresh: Post): boolean {
  return fresh.content.length > stored.content.length;
}

/**
 * A stored body that is nothing but X's shortened media link.
 *
 * A caption-less tweet's body is exactly this: the adapter now emits empty text
 * for it (`display_text_range` / `isMediaOnlyLinkText`), but rows written before
 * that fix — and by the payloads that omitted the range — keep the link as their
 * body, and a normal sync never rewrites existing rows. The shape is unambiguous:
 * a body that is *nothing but* a t.co URL is either that artefact or a stored
 * media link, never author text worth preserving.
 */
function isBareShortLink(text: string): boolean {
  return /^https:\/\/t\.co\/\w+$/.test(text.trim());
}

/**
 * Whether a stored row's text should be replaced by what the adapter just parsed.
 *
 * Deliberately per-platform and narrow. Each rule matches only a shape that can
 * *only* be an artefact of a bug this project shipped, so the replacement can
 * never discard correct content: the RSS rule needs the freshly parsed body to be
 * strictly longer (bodies only ever get more complete), and the Twitter rule needs
 * a body consisting solely of a media link.
 */
export function shouldRepairStoredContent(stored: Post, fresh: Post): boolean {
  if (stored.platform !== fresh.platform) return false;
  if (stored.platform === 'rss') return isRssBodySuperseded(stored, fresh);
  if (stored.platform === 'twitter') {
    return isBareShortLink(stored.content) && fresh.content !== stored.content;
  }
  return false;
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
      } catch {
        // Watermark read failed: fall back to fetching without sinceTimestamp.
      }
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
      // The per-channel failure the UI only shows as a red pip: name the code
      // and the platform, never the response body.
      devLog.warn(
        'channelSync',
        `${channel.platform}/${channel.displayName || channel.accountId} 同步失败（${result.error.code}）`,
        friendly,
      );
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
            } catch {
              // Read failure: proceed without the regression guard.
            }
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
        } catch {
          // Upsert path failed: keep the fetch alive with the unfiltered batch.
        }
      } else if (sinceTimestamp > 0) {
        newPosts = result.posts.filter(p => p.publishedAt > sinceTimestamp);

        // Content repair for rows an earlier build wrote incorrectly.
        //
        // Strictly bounded: only the ids the adapter just returned (≤ one page,
        // via `bulkGet` — never a table scan), and only rows matching a rule in
        // `shouldRepairStoredContent`, each of which can only ever match a shape
        // this project's own bugs produced. Repaired rows are written back
        // silently: they are not new posts, so they must not inflate the count,
        // and the user's read/bookmark state is preserved. Once repaired the
        // conditions stop matching.
        const alreadyKnown = result.posts.filter(p => p.publishedAt <= sinceTimestamp);
        if (alreadyKnown.length > 0) {
          try {
            const storedRows = await db.posts.bulkGet(alreadyKnown.map(p => p.id));
            const repaired: Post[] = [];
            for (let i = 0; i < alreadyKnown.length; i++) {
              const fresh = alreadyKnown[i];
              const stored = storedRows[i];
              if (stored && shouldRepairStoredContent(stored, fresh)) {
                repaired.push({
                  ...fresh,
                  isRead: stored.isRead,
                  isBookmarked: stored.isBookmarked,
                });
              }
            }
            if (repaired.length > 0) {
              await db.posts.bulkPut(repaired);
              devLog.info(
                'channelSync',
                `已修正 ${repaired.length} 条历史动态的正文`,
                `${channel.platform}：旧的错误文本已用重新解析的结果覆盖`,
              );
            }
          } catch {
            // Repair is opportunistic: a failure leaves the row for the next sync.
          }
        }
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
        } catch {
          // Tombstone read failed: keep posts rather than resurrect deletions.
        }
      } else {
        try {
          const fetchedIds = newPosts.map(p => p.id);
          if (fetchedIds.length > 0) {
            await db.deletedPostIds.bulkDelete(fetchedIds);
          }
        } catch {
          // Tombstone clear failed: restore still proceeds; the stale
          // tombstone will filter this post on the next ordinary sync.
        }
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
    // `水位线` is what makes「平台返回 0 条」interpretable: with a watermark the
    // adapter is expected to filter already-known posts away, without one it
    // returned nothing on a first/forced sync — the case worth investigating.
    const watermark = sinceTimestamp
      // Timestamps may be seconds or milliseconds depending on the adapter.
      ? new Date(sinceTimestamp < 1e12 ? sinceTimestamp * 1000 : sinceTimestamp).toLocaleString('zh-CN')
      : '无（首次或强制同步）';
    devLog.info(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 同步完成`,
      [
        `新增 ${enhancedPosts.length} 条`,
        `平台返回 ${result.posts?.length || 0} 条`,
        // Raw count before the adapter's own filtering. Only adapters that
        // filter internally (bilibili / douyin / xiaohongshu / twitter) report
        // it; for the rest this is omitted rather than printed as「未知」,
        // because a placeholder sitting beside real numbers reads like a value.
        ...(result.totalFetched === undefined ? [] : [`平台原始 ${result.totalFetched} 条`]),
        `hasMore=${String(result.hasMore)}`,
        `水位线=${watermark}`,
        `仅原创=${mergedOptions.onlyOriginal ? '是' : '否'}`,
      ].join('，'),
    );
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
    devLog.error(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 抛出异常`,
      structured.message,
    );
    return { posts: [], error: structured };
  } finally {
    // Failsafe: Ensure channel is NEVER left in 'updating' status
    const current = await db.channels.get(channel.id);
    if (current?.status === 'updating') {
      await db.channels.update(channel.id, { status: 'idle' });
    }
  }
}
