import Dexie from 'dexie';
import type { Creator, Channel, Post } from '../types';
import { PLATFORM_REGISTRY } from '../types';
import type { FetchError, FetchOptions, FetchResult } from '../adapters/types';
import { canRunInServiceWorker, fetchError } from '../adapters/types';
import { getAdapter } from '../platform/registry';
import { IS_SERVICE_WORKER } from '../utils/runtime';
import { isChannelRunning, notePlatformFinished, withChannelRun } from './syncCoordinator';
import { GENERATED_NAME_PREFIXES } from '../utils/urlParser';
import { db } from '../infrastructure/db/database';
import { adoptRenamedPostIds, getSuppressedPostIds, clearSuppressions } from '../infrastructure/db/postRepository';
import { devLog } from '../utils/devLog';
import { toEpochMsOr } from '../utils/timestamp';
import {
  END_OF_HISTORY_CURSOR,
  shouldRecordHistoryEnd,
  statesEndOfHistory,
} from './cursorState';

class FetchTimeoutError extends Error {}

/**
 * Abort when EITHER signal aborts.
 *
 * `AbortSignal.any` is the platform's own answer (Chrome 116+, below this
 * extension's floor), with a hand-rolled fallback for the non-extension
 * environments the unit tests run in. The fallback links the two with
 * `addEventListener` and removes the listeners once either fires, so a
 * long-lived caller signal does not accumulate one listener per sync.
 */
export function composeAbortSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a === b) return a;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const controller = new AbortController();
  const abort = (reason?: unknown) => {
    controller.abort(reason);
    a.removeEventListener('abort', onA);
    b.removeEventListener('abort', onB);
  };
  const onA = () => abort(a.reason);
  const onB = () => abort(b.reason);
  if (a.aborted) abort(a.reason);
  else if (b.aborted) abort(b.reason);
  else {
    a.addEventListener('abort', onA, { once: true });
    b.addEventListener('abort', onB, { once: true });
  }
  return controller.signal;
}

/**
 * Was this name one WE generated, for a row written before `nameSource` existed?
 *
 * Only ever consulted when `nameSource === undefined`. Derived from
 * `urlParser.GENERATED_NAME_PREFIXES` — not a second hand-written list, which
 * is the shape that drifted twice and silently pinned machine names
 * (audit P1-5, AGENTS rule 9). Each such row gets one chance to be repaired;
 * the write then stamps `nameSource: 'platform'` and the heuristic is never
 * consulted for it again.
 */
function legacyPlaceholderName(name: string, platform: string, accountId: string): boolean {
  if (!name) return true;
  if (name === accountId) return true;
  const bare = accountId.replace(/^@/, '');
  if (name === bare || name === `@${bare}`) return true;
  if (name.startsWith(platform)) return true;
  return GENERATED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** The creator-side half of `legacyPlaceholderName` (its old default names differ). */
function legacyCreatorPlaceholderName(name: string, accountId: string): boolean {
  if (!name) return true;
  if (name === '新创作者' || name === '未命名创作者') return true;
  if (name === accountId) return true;
  const bare = accountId.replace(/^@/, '');
  if (name === bare || name === `@${bare}`) return true;
  return GENERATED_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Is this a local storage failure rather than a platform/network one?
 *
 * Dexie wraps the underlying `DOMException` in a plain Error whose `name`/`message`
 * carry the original ("QuotaExceededError", "AbortError", or a transaction failure
 * like "The transaction was aborted"). Inspecting both keeps the classification
 * honest without matching on our own error strings.
 *
 * Exported because `batchSync` must make the same call when a per-channel sync
 * throws out of its own try/catch (AUDIT P1-1).
 */
export function isStorageFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const text = `${err.name} ${err.message}`;
  return /QuotaExceededError|UnknownError|AbortError|transaction was aborted|DatabaseClosedError|InvalidStateError|IndexedDB/i.test(text);
}

/**
 * Friendly wording for error classes the sync layer understands. With the
 * structured FetchError contract this is a code lookup, not message regexing.
 */
function friendlyError(err: FetchError): string {
  switch (err.code) {
    case 'rate_limit':
      return '触发平台防刷频率限制。目标平台正在进行安全限流冷却，请等待 2~3 分钟后再刷新，避免频繁请求。';
    case 'storage':
      // Name the local cause and explicitly clear the platform: this failure
      // says nothing about whether the site was reachable.
      return `${err.message}（本地存储问题，与平台是否可达无关）`;
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
  if (fresh.content.length > stored.content.length) return true;
  // The article HTML arrived after the plain-text fix, so rows repaired by that
  // rule hold the complete text but no structure — the reader would keep
  // flattening them. Rewriting whenever the fresh row has HTML and the stored one
  // does not also converges: after one repair both sides have it.
  return Boolean(fresh.contentHtml) && !stored.contentHtml;
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
 * A stored body that is the fresh one with X's appended link still on the end.
 *
 * The shape the trailing-link bug produced: `正文… https://t.co/xxxx` stored while
 * the adapter now parses `正文…`. The rule is exact rather than "similar" — the
 * stored text must *begin with* the fresh text and have nothing after it but
 * t.co URLs — so a row whose body legitimately differs can never match. It also
 * never shortens content: the only thing removed is a link X appended.
 */
function isStoredWithAppendedLink(stored: string, fresh: string): boolean {
  const body = fresh.trim();
  // An empty fresh body belongs to the bare-link rule above, which owns that
  // shape; keeping them disjoint means each is provable on its own terms.
  if (!body) return false;

  const text = stored.trim();
  if (!text.startsWith(body)) return false;

  const suffix = text.slice(body.length).trim();
  return /^(https:\/\/t\.co\/\w+[ \t]*)+$/.test(suffix);
}

/**
 * A stored note link with no `xsec_token`, where the fresh one carries it.
 *
 * The shape the 404 bug produced: `https://www.xiaohongshu.com/explore/<id>` with
 * nothing else, stored while the adapter now builds the same URL with the token
 * the profile page supplies. Narrow by construction — the stored value must be a
 * xiaohongshu `explore/<same id>` URL with NO query string at all, and the fresh
 * one must be that same URL plus `xsec_token`. A link the user edited, a share
 * link with other parameters, or a different id can never match, so the
 * replacement can only ever add the token that was missing.
 */
function isXhsNoteLinkMissingToken(stored: string, fresh: string): boolean {
  if (!stored || !fresh) return false;
  let s: URL;
  let f: URL;
  try {
    s = new URL(stored);
    f = new URL(fresh);
  } catch {
    return false;
  }
  if (s.hostname !== 'www.xiaohongshu.com' || f.hostname !== 'www.xiaohongshu.com') return false;
  // The stored form must be EXACTLY the bare link — any query at all means it is
  // not the shape this bug wrote.
  if (s.search !== '') return false;
  if (s.pathname !== f.pathname) return false;
  if (!/^\/explore\/[0-9a-f]{24}$/.test(s.pathname)) return false;
  return f.searchParams.get('xsec_token') !== null;
}

/**
 * Whether a stored row's text should be replaced by what the adapter just parsed.
 *
 * Deliberately per-platform and narrow. Each rule matches only a shape that can
 * *only* be an artefact of a bug this project shipped, so the replacement can
 * never discard correct content: the RSS rule needs the freshly parsed body to be
 * strictly longer (bodies only ever get more complete), the Twitter rules need a
 * body that is either solely a media link or the fresh text plus nothing but
 * trailing t.co links, and the xiaohongshu rule needs a bare `explore/<id>` link
 * that the fresh row improves with a token.
 */
export function shouldRepairStoredContent(stored: Post, fresh: Post): boolean {
  if (stored.platform !== fresh.platform) return false;
  if (stored.platform === 'rss') return isRssBodySuperseded(stored, fresh);
  if (stored.platform === 'twitter') {
    return (isBareShortLink(stored.content) || isStoredWithAppendedLink(stored.content, fresh.content))
      && fresh.content !== stored.content;
  }
  if (stored.platform === 'xiaohongshu') {
    return isXhsNoteLinkMissingToken(stored.originalUrl, fresh.originalUrl);
  }
  return false;
}

/**
 * Executes an on-demand update for a single channel with timeout safety & rate-limiting protection.
 *
 * **Single-flight.** Six entry points call this (dashboard refresh-all /
 * refresh-creator / refresh-channel / deep-sync, the popup's `SYNC_CHANNEL`, and
 * the auto-sync alarm) and nothing coordinated them, so one channel could be
 * fetched twice concurrently — each run holding a Channel snapshot from a
 * different moment, last writer winning, `nextCursor` silently rewound by
 * whichever finished second. The lock lives here because this is the one
 * function all six cross; a per-caller guard cannot see another context's run.
 * A second call for a channel already in flight joins the first and receives its
 * result, so there is one fetch and one write.
 */
export async function updateChannel(
  channel: Channel,
  limit: number = 10,
  force: boolean = false,
  options?: FetchOptions
): Promise<FetchResult> {
  if (isChannelRunning(channel.id)) {
    devLog.debug(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 已有同步在跑，加入它`,
      '同一频道的并发同步会互相覆盖 nextCursor / status，因此合并为一次',
    );
  }
  return withChannelRun(channel.id, () => runChannelUpdate(channel, limit, force, options));
}

async function runChannelUpdate(
  channel: Channel,
  limit: number,
  force: boolean,
  options?: FetchOptions,
): Promise<FetchResult> {
  const adapter = getAdapter(channel.platform);
  if (!adapter) {
    // A silent return here was invisible: the channel simply never appeared in
    // the log, which reads as "the sync stopped" rather than "this platform has
    // no adapter" (a real state after a platform removal).
    devLog.warn(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 跳过：没有对应适配器`,
      '该平台可能已在本版本移除；频道会在界面上标记为不支持的平台。',
    );
    return { posts: [], error: fetchError('unsupported', `不支持的平台: ${channel.platform}`) };
  }

  // A platform that cannot run here is refused BEFORE the request, from its own
  // declaration — not discovered by the adapter mid-attempt.
  //
  // Both douyin and twitter do refuse inside `fetchLatest` when they detect the
  // worker, and that stays as the backstop. What this adds is the KNOWLEDGE at
  // the one place every worker-side path crosses (the alarm, the popup's
  // `SYNC_CHANNEL`, the dashboard's batch loop when it runs in the SW): the
  // platform is known before dispatch, so the attempt is not made at all.
  //
  // The popup is why it matters: `SYNC_CHANNEL` deliberately runs in the worker
  // so the fetch survives the popup closing, which means following a douyin or
  // twitter creator from the popup could only ever fail — the channel was stored
  // and its first posts never were. The message says where it DOES work, because
  // "not supported" alone leaves the user with no next step.
  if (IS_SERVICE_WORKER && !canRunInServiceWorker(adapter)) {
    devLog.warn(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 跳过：该平台不能在后台运行`,
      '需要在扩展页面中同步；由调用方在页面上下文重试。',
    );
    return {
      posts: [],
      error: fetchError(
        'unsupported',
        `${PLATFORM_REGISTRY[channel.platform]?.name ?? channel.platform} 需要在扩展页面中同步，后台无法采集。请打开仪表盘后手动同步该账号。`,
      ),
    };
  }

  // Cooldown protection: if updated successfully within 30 seconds and not forced, skip hitting network
  if (!force && !options?.cursor && channel.lastSuccessAt && Date.now() - channel.lastSuccessAt < 30_000) {
    devLog.debug(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 跳过：30 秒内已成功同步`,
      `距上次成功 ${Math.round((Date.now() - channel.lastSuccessAt) / 1000)} 秒，未强制刷新`,
    );
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
    // The 45s budget must CANCEL the work, not merely stop waiting for it
    // (AUDIT P1-2). Before this the timeout resolved while the underlying fetch
    // kept running, so a user who retried during the wait had two live requests
    // against a platform whose protection model is a request ceiling — exactly
    // what the pacing/cooldown machinery exists to prevent.
    //
    // Twitter may need an existing authenticated tab fallback; allow enough time
    // for it to load. Injected collection (Twitter/Douyin) is not cancellable
    // mid-injection — `chrome.scripting` has no abort — so those adapters check
    // the signal between steps; the tab work is bounded by its own budget.
    const abortController = new AbortController();
    const timeoutPromise = new Promise<FetchResult>((_, reject) => {
      setTimeout(() => {
        abortController.abort();
        reject(new FetchTimeoutError('同步请求超时（已超过 45 秒未响应，请检查平台登录状态）'));
      }, 45_000);
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

    const mergedOptions: FetchOptions = {
      ...options,
      sinceTimestamp,
      // The 45s deadline must still CANCEL when a caller supplied its own signal.
      //
      // This was `options?.signal ?? abortController.signal` — a choice, not a
      // combination. With a caller signal present the deadline lost its only
      // lever, so the timeout rejected the promise while the underlying fetch
      // kept running: the exact "resolved while the request continued" failure
      // the abort controller was added to fix (AUDIT P1-2), reintroduced for any
      // caller that cancels. No caller passes one today, which is why it went
      // unnoticed — the defect was waiting for the feature that needs it.
      signal: composeAbortSignals(options?.signal, abortController.signal),
    };

    // Why this line exists: a real session's log contained the fetch lines for a
    // channel and then, twenty-seven seconds later, its 「同步完成」 line — with
    // nothing in between. The gap was the acquisition (page load, injection,
    // contract validation, mapping), which emitted nothing, so the user asked
    // whether Douyin had stopped responding. It had not; the log simply did not
    // cover the interval it was being asked about. `debug` because it is
    // high-volume on a successful path (rule 11), and it names the mode so the
    // same channel's normal sync, dig and forced refresh are distinguishable.
    const mode = options?.isHistory || options?.cursor !== undefined
      ? '历史回溯'
      : options?.forceRefresh
        ? '强制刷新'
        : options?.restoreDeleted
          ? '恢复已删'
          : '常规';
    devLog.debug(
      'channelSync',
      `${channel.platform}/${channel.displayName || channel.accountId} 开始同步（${mode}）`,
      [
        `上限 ${limit} 条`,
        sinceTimestamp ? `水位线 ${new Date(toEpochMsOr(sinceTimestamp, sinceTimestamp)).toLocaleString('zh-CN')}` : '无水位线',
        options?.cursor !== undefined ? `游标 ${String(options.cursor)}` : '',
      ].filter(Boolean).join('，'),
    );

    const startedAt = Date.now();
    const result = await Promise.race([adapter.fetchLatest(channel, limit, mergedOptions), timeoutPromise]);

    if (result.error && result.posts.length === 0) {
      // End-of-history is signalled by hasMore === false or a not_found code,
      // never by message wording. The predicate lives in `cursorState.ts` with the
      // rest of the policy, because writing this sentinel wrongly is the one
      // mistake in this file the user cannot undo.
      if (statesEndOfHistory(result)) {
        await db.channels.update(channel.id, {
          status: 'success',
          nextCursor: END_OF_HISTORY_CURSOR,
          errorMessage: undefined,
          lastCheckAt: Date.now(),
          lastSuccessAt: Date.now(),
        });
        // Third silent return. It wrote a success status and a terminal cursor
        // but produced no line, so a channel that reported "nothing here" looked
        // identical to one that was never reached — and this is the one write in
        // the file the user cannot undo, so it has to be on the record.
        devLog.info(
          'channelSync',
          `${channel.platform}/${channel.displayName || channel.accountId} 已到历史底部`,
          `平台声明没有更多内容（${result.error?.code ?? 'hasMore=false'}），游标记为终点。`,
        );
        return { ...result, error: undefined };
      }

      const friendly = friendlyError(result.error);
      await db.channels.update(channel.id, {
        status: 'error',
        errorMessage: friendly,
        lastCheckAt: Date.now(),
      });
      // The per-channel failure the UI only shows as a red pip: name the code
      // and the platform, never the response body. Elapsed time is included
      // because "failed after 40s" and "failed after 0.2s" are different bugs
      // (a timeout vs an immediate rejection) and the previous line could not
      // tell them apart.
      devLog.warn(
        'channelSync',
        `${channel.platform}/${channel.displayName || channel.accountId} 同步失败（${result.error.code}）`,
        `${friendly}｜耗时 ${Date.now() - startedAt}ms`,
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
      /** Pairs moved by `adoptRenamedPostIds`, needed again when writing. */
      let pendingRenames: Array<{ from: string; to: string }> = [];

        // Rows the adapter renamed. `Post.id` is a global primary key and the
        // suppression is keyed by it, so a scheme change has to MOVE the stored
        // row — otherwise the same item exists twice (old id orphaned with the
        // user's read/bookmark state, new id freshly written) and a 彻底删除
        // recorded against the old id stops applying.
        //
        // The adapter reports the pairing because it is the only place that knows
        // both ids; this is bounded to the page it just returned, which is the
        // only honest scope (rule 16).
        if (result.renamedIds && result.renamedIds.length > 0) {
          // Taken as given, never re-derived by pairing against `result.posts`:
          // the adapter knows both ids for each item, and a positional join here
          // is what would let a skipped item migrate the wrong row.
          pendingRenames = result.renamedIds;
          const moved = await adoptRenamedPostIds(pendingRenames);
          if (moved > 0) {
            devLog.info(
              'channelSync',
              `已把 ${moved} 条动态迁移到新的 ID（${channel.platform}）`,
              '该平台的 ID 生成方式变了（例如 RSS 纳入来源作用域），旧行连同已读/收藏与删除记录一并迁移。',
            );
          }
        }

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
                `已修正 ${repaired.length} 条历史动态`,
                `${channel.platform}：旧的错误字段已用重新解析的结果覆盖`,
              );
            }
          } catch {
            // Repair is opportunistic: a failure leaves the row for the next sync.
          }
        }
      }

      // Suppression filter (I7) — default path. The suppression is keyed by
      // `Post.id`, not by channel: a post deleted under one channel must stay
      // hidden even if the same id arrives through another one (Twitter
      // rename), so a `where('channelId')` lookup was the wrong shape.
      //
      // FAIL CLOSED (I10): a read failure must abort the write, not proceed
      // with the unfiltered batch. The old `catch {}` here resurrected every
      // deletion the moment IndexedDB hiccuped, and the log could not tell.
      if (!options?.restoreDeleted) {
        const suppressed = await getSuppressedPostIds(newPosts.map(p => p.id));
        if (suppressed.size > 0) {
          newPosts = newPosts.filter(p => !suppressed.has(p.id));
        }
      } else {
        // restoreDeleted: the user explicitly asked for these back, so the
        // suppression is cleared for exactly the ids the adapter returned.
        await clearSuppressions(newPosts.map(p => p.id));
      }

      // Preserve user state for rows this sync is about to overwrite.
      //
      // Normally `newPosts` holds ids the DB has never seen, so writing them
      // fresh cannot lose anything. The exception is a row whose ID just changed
      // (an adapter identity migration, e.g. RSS gaining its feed scope): the
      // stored copy holds the user's read/bookmark state, and the adapter's fresh
      // copy always carries `isRead: 0`. Without this the migration would move
      // the row and then immediately overwrite the state it had preserved —
      // measured: `isRead: 1` became 0 across the adoption.
      if (pendingRenames.length > 0 && newPosts.length > 0) {
        const renamedTo = new Map(pendingRenames.map((r) => [r.to, r.from]));
        const carried = await db.posts.bulkGet(newPosts.map((p) => p.id));
        newPosts = newPosts.map((p, i) => {
          const stored = carried[i];
          if (!stored) return p;
          // Either the id itself is post-adoption (looked up directly), or it is
          // the new id of a pair we just moved — both mean "the user has state".
          const wasRenamed = renamedTo.has(p.id);
          if (!wasRenamed && stored.isRead === p.isRead && stored.isBookmarked === p.isBookmarked) {
            return p;
          }
          return {
            ...p,
            isRead: stored.isRead || p.isRead ? 1 : 0,
            isBookmarked: stored.isBookmarked || p.isBookmarked ? 1 : 0,
          };
        });
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
      } else if (shouldRecordHistoryEnd(result)) {
        updates.nextCursor = END_OF_HISTORY_CURSOR;
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
      // `nameSource` answers this directly: only a name WE generated may be
      // replaced by the platform's. A user-renamed channel (`user`) or one
      // already carrying the platform's own name (`platform`) is left alone —
      // including a deliberate name like `Pixiv作品_集`, which the old
      // prefix-matching heuristic would have overwritten on every sync.
      //
      // A row from before the field existed has no `nameSource`, so it falls
      // back to the shape check ONCE: the moment a name is written here it is
      // stamped `platform`, and the row never consults the heuristic again.
      // That is what makes this self-clearing rather than a second lasting rule.
      const isPlaceholderName =
        channel.nameSource === undefined
          ? legacyPlaceholderName(currentName, channel.platform, channel.accountId)
          : channel.nameSource === 'generated';

      if (isPlaceholderName && authName) {
        updates.displayName = authName;
        updates.nameSource = 'platform';
      }
    }
    // Always update avatarUrl on channel (not just when empty, to stay fresh)
    if (result.authorMeta?.avatar) {
      updates.avatarUrl = result.authorMeta.avatar;
    }
    // Persist a freshly discovered platform id, so the platform can skip the
    // page it had to read to find it.
    //
    // Only written when the adapter actually resolved something THIS run (it
    // reports `undefined` when the channel already carried an id), so the fast
    // path performs no write at all. That is what makes this converge: the
    // expensive discovery happens once per channel, not once per sync. Measured
    // motivation — YouTube's profile page is 1.16 MB with the id at byte ~750k,
    // and it was being re-downloaded on every sync because the value was
    // computed and thrown away.
    if (result.authorMeta?.resolvedAccountId) {
      updates.resolvedAccountId = result.authorMeta.resolvedAccountId;
      devLog.info(
        'channelSync',
        `${channel.platform}/${channel.displayName || channel.accountId} 已记录平台账号 ID`,
        `后续同步将直接使用 ${result.authorMeta.resolvedAccountId}，不再重新解析页面`,
      );
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
          // Same rule as the channel above, same self-clearing fallback for
          // rows written before `nameSource` existed. The old separate
          // hand-written list of creator-side prefixes is gone with it.
          const isDefaultCreatorName =
            creator.nameSource === undefined
              ? legacyCreatorPlaceholderName(creator.name, channel.accountId)
              : creator.nameSource === 'generated';

          if (isDefaultCreatorName && authName) {
            creatorUpdates.name = authName;
            creatorUpdates.nameSource = 'platform';
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
      ? new Date(toEpochMsOr(sinceTimestamp, sinceTimestamp)).toLocaleString('zh-CN')
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
        // Bounds the acquisition: the start line and this one are the two ends
        // of the interval that used to be blank.
        `耗时 ${Date.now() - startedAt}ms`,
      ].join('，'),
    );

    // A degraded result still wrote its posts, so it is not an error — but it
    // must not read as a clean sync either (audit P1-3). `warn`, because the
    // user-visible effect is "this creator seems to have posted less", which is
    // exactly the symptom the log needs to be able to explain.
    if (result.degraded) {
      devLog.warn(
        'channelSync',
        `${channel.platform}/${channel.displayName || channel.accountId} 同步结果不完整`,
        (result.warnings ?? ['平台的部分数据源未返回，结果可能偏少']).join('；'),
      );
    }
    return {
      ...result,
      posts: enhancedPosts,
      totalFetched: result.posts?.length || 0,
    };
  } catch (err: unknown) {
    // Failure-domain split (AUDIT P1-1). A write failure used to be reported as
    // 「平台网络错误」, which is not just wrong wording: `code` drives the
    // platform cool-down and the history-end decision, so a local storage
    // problem cooled down a platform that was never contacted. Dexie rejects
    // with an Error wrapping the DOMException, and quota/abort surface as
    // `name` variants, so both are inspected.
    const structured = err instanceof FetchTimeoutError
      ? fetchError('timeout', err.message)
      : isStorageFailure(err)
        ? fetchError('storage', `本地数据库写入失败：${err instanceof Error ? err.message : String(err)}`)
        : err instanceof Error
          ? fetchError('network', err.message)
          : fetchError('network', '未知异常');
    // A storage failure is local, so it must not be written as the platform's
    // error message and must not feed any platform-scoped policy — but it also
    // cannot be stored (the write is what failed), so the user sees it in the
    // log and the channel keeps whatever status it had.
    if (structured.code === 'storage') {
      devLog.error(
        'channelSync',
        `${channel.platform}/${channel.displayName || channel.accountId} 本地存储失败`,
        structured.message,
      );
      return { posts: [], error: structured };
    }
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
    // Recorded on EVERY path, including failure: a request that failed still hit
    // the platform, so the spacing that follows must account for it (rule 19).
    // Shared across entry points, so a concurrent batch cannot start from "this
    // platform was never contacted" and fire immediately.
    notePlatformFinished(channel.platform);
    // Failsafe: Ensure channel is NEVER left in 'updating' status
    const current = await db.channels.get(channel.id);
    if (current?.status === 'updating') {
      await db.channels.update(channel.id, { status: 'idle' });
    }
  }
}
