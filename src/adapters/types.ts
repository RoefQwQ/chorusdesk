import type { Channel, Post } from '../types';

export interface FetchOptions {
  onlyOriginal?: boolean;
  cursor?: string;
  /** Set to true when digging older historical posts */
  isHistory?: boolean;
  /** Only fetch posts published after this timestamp (ms). Used for incremental sync. */
  sinceTimestamp?: number;
  /** If true, include previously deleted posts and clear their tombstone records upon fetch */
  restoreDeleted?: boolean;
  /** If true, ignore sinceTimestamp watermark to force-refresh and update existing posts in local DB */
  forceRefresh?: boolean;
  /**
   * Budget for genuinely NEW posts this fetch may persist. History digs
   * upsert duplicates without consuming budget; only new-id rows are counted
   * and sliced. Absent/0 = unconstrained.
   */
  maxNewPosts?: number;
  /**
   * Cancels the in-flight acquisition.
   *
   * Set by `channelSync` when its 45s budget expires, so the request actually
   * stops instead of merely being stopped waiting for (AUDIT P1-2). Adapters
   * pass it to `bgFetch`. Page-driven platforms cannot honour it mid-injection
   * (`chrome.scripting` is not cancellable) — they check it between steps.
   */
  signal?: AbortSignal;
}

/**
 * Structured error for FetchResult. Adapters classify the failure so the sync
 * layer can decide retryability and message wording without regexing the
 * message string (which is what `normalizeErrorMessage` used to do).
 */
export type FetchErrorCode =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'parse'
  | 'timeout'
  | 'not_found'
  | 'unsupported'
  /**
   * Our own storage failed (IndexedDB write/read), not the platform's network.
   *
   * It must not be classified as `network`: `code` is not a message — it drives
   * the platform cool-down (`batchSync` calls `noteRateLimit` on `rate_limit`,
   * clears on success), the history-end decision and the user-facing wording.
   * A quota error reported as「平台网络错误」would cool down a platform that was
   * never contacted and hide a local disk problem. (AUDIT P1-1.)
   */
  | 'storage';

export interface FetchError {
  /** Machine-readable failure class; drives sync-layer policy, not display. */
  code: FetchErrorCode;
  /** Human-readable Chinese message, safe to surface in the UI as-is. */
  message: string;
}

export function fetchError(code: FetchErrorCode, message: string): FetchError {
  return { code, message };
}

/**
 * Classify an HTTP failure status into a `FetchErrorCode`.
 *
 * Why this is shared rather than left to each adapter: `code` is not a label, it
 * is policy. `rate_limit` starts a PERSISTED platform cool-down (rule 19) and
 * replaces the adapter's message with a hardcoded 「请等待 2~3 分钟」; `not_found`
 * makes a history dig write the `__END__` sentinel, which permanently stops the
 * channel from ever digging again. Every other code changes only the wording.
 *
 * The adapters each hand-classified this and disagreed. Measured before this
 * existed: weibo mapped 403 to `auth` and everything else — including 429 — to
 * `network`; xiaohongshu mapped every status to `network`; pixiv and fantia threw
 * the status into a message that the outer catch turned into `network`. So a
 * platform answering `429 Too Many Requests` was reported as a connection problem
 * and **never entered a cool-down**, which is the one response rule 19 exists for.
 *
 * `4xx` is deliberately specific:
 *  - `401`/`403` are `auth`. Both mean "your session is not good enough", and the
 *    user can act on that; calling them `network` sends them to check their wifi.
 *  - `429` is `rate_limit`. The platform is telling us to stop for a while.
 *  - `404`/`410` are `not_found` — the platform says the thing is not there.
 *    **Caveat, and it is why this is not used for an empty page:** `not_found`
 *    reaches `statesEndOfHistory`, so on a history dig it writes `__END__`. A
 *    transport-level 404 is evidence about the REQUEST, not proof the channel is
 *    exhausted (an expired signed URL answers 404 too). Adapters that dig should
 *    keep saying "no more" only from a real pagination signal.
 *  - other `4xx` is `network`: a request the server refused for its own reasons,
 *    which retrying identically will not fix and which is not the user's session.
 * `5xx` is `network` — the platform is broken, not the request.
 *
 * `platform` only shapes the message so the user knows where to look.
 */
export function httpStatusError(status: number, platform: string): FetchError {
  if (status === 429) {
    return fetchError('rate_limit', `${platform} 触发了请求频率限制（HTTP 429），已进入冷却。`);
  }
  if (status === 401 || status === 403) {
    return fetchError(
      'auth',
      `${platform} 拒绝了本次请求（HTTP ${status}）。通常表示浏览器未登录或登录已过期，请登录后重试。`,
    );
  }
  if (status === 404 || status === 410) {
    return fetchError('not_found', `${platform} 表示该内容不存在（HTTP ${status}）。`);
  }
  return fetchError('network', `${platform} 响应异常 HTTP ${status}。`);
}

/**
 * An HTTP-status failure carrying its own wording, to be resolved by
 * `toFetchError` at the adapter's outer catch.
 *
 * Adapters that wrap a whole `try` around the acquisition (pixiv, fantia) can
 * only classify centrally in that catch, and `errorMessage(err)` there cannot see
 * a status — so the status used to be flattened into `network` regardless of what
 * it was. Throwing this instead keeps the class (`rate_limit`, `auth`, …) while
 * letting the adapter keep the message its platform warrants.
 */
export class HttpStatusError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/**
 * Classify a caught error, preserving an `HttpStatusError`'s HTTP class.
 *
 * `toFetchError(err, 'Pixiv', 'Pixiv 抓取失败…')` — the adapter's own message is
 * used when it threw a plain `Error` (parse/schema problems, which are `parse`),
 * and the status decides the code when it threw an `HttpStatusError`.
 */
export function toFetchError(err: unknown, platform: string, fallbackMessage: string): FetchError {
  if (err instanceof HttpStatusError) {
    const classified = httpStatusError(err.status, platform);
    // Status decides the class; the adapter's message explains THIS endpoint.
    return { code: classified.code, message: err.message };
  }
  return fetchError('parse', err instanceof Error && err.message ? err.message : fallbackMessage);
}

export interface FetchResult {
  posts: Post[];
  authorMeta?: {
    name?: string;
    avatar?: string;
    /**
     * The platform's own id, when this run resolved it (see
     * `Channel.resolvedAccountId`). Persisted by `channelSync` so a platform
     * whose id must be discovered from a page — YouTube, where that page is
     * 1.16 MB — pays for it once instead of on every sync.
     */
    resolvedAccountId?: string;
  };
  nextCursor?: string;
  /** False when the adapter knows there is nothing older to fetch. */
  hasMore?: boolean;
  error?: FetchError;
  /** Total raw posts returned by adapter in this batch before DB deduplication */
  totalFetched?: number;
  /**
   * Items whose `Post.id` scheme changed, as EXPLICIT old→new pairs.
   *
   * The adapter is the only place that knows both ids, because the inputs (guid,
   * channel id, fallback chain) live there and a migration re-deriving them would
   * reimplement it and could disagree. `channelSync` uses these to MOVE the
   * stored row, its suppression and its recycle snapshot onto the new id —
   * bounded to what the adapter just returned, the only honest scope (rule 16).
   *
   * Pairs, not two positionally-aligned arrays: the consumer acts destructively
   * (it moves rows and their deletion records), so a shifted index would migrate
   * the WRONG row. An array of pairs cannot shift.
   */
  renamedIds?: Array<{ from: string; to: string }>;
  /**
   * Set when the adapter returned content, but at least one of its sources
   * failed — the result is real but incomplete.
   *
   * This is the failure that has no other symptom: a multi-source platform
   * (bilibili dynamic + medialist, XHS list + enrichment, Twitter tab + direct)
   * whose supplementary source is down returns a valid, shorter page. Nothing
   * reports an error and `hasMore` is honest about the page, so the user reads
   * "this creator did not post" and the log says 同步完成 (audit P1-3).
   *
   * Distinct from `error` on purpose: a degraded result still WRITES its posts
   * (partial data beats none), whereas an `error` result with no posts does not.
   * The sync layer logs these and never lets one masquerade as a clean sync.
   */
  degraded?: boolean;
  /** Human-readable notes on what was missing, for the Developer Log. */
  warnings?: string[];
}

export interface PlatformAdapter {
  platform: string;
  /**
   * Minimum spacing between two requests to this platform, in ms.
   *
   * Platform knowledge, so it lives with the platform (AGENTS rule 8). A request
   * to Douyin is not an API call — it opens a tab and loads a full page — so its
   * floor is much higher than an API platform's, and the sync layer treats the
   * value as a floor it may raise but never lower.
   *
   * Absent = the generic default (`DEFAULT_MIN_INTERVAL_MS`).
   */
  minRequestIntervalMs?: number;
  /**
   * Whether this platform's media is worth archiving to the user's disk.
   *
   * Absent = yes. RSS says no (2026-09-12): a feed's images live on whatever host
   * the publisher uses — often a CDN that answers `403` to anything without a
   * matching `Referer`, which the image proxy cannot forge — so the batch archive
   * spent its time on guaranteed failures and the log filled with
   * 「图片代理 assets.juya.uk 失败 403」. Measured on one real library: 7 of 7
   * failures were RSS. Archiving exists for platforms whose image URLs expire
   * (xiaohongshu's signed CDN links); a feed can simply be re-fetched.
   */
  archivesMedia?: boolean;
  fetchLatest(channel: Channel, limit?: number, options?: FetchOptions): Promise<FetchResult>;

  /** Optional platform-specific historical fetch implementation. */
  fetchHistory?(
    channel: Channel,
    uid: string,
    limit: number,
    options: FetchOptions,
    authorName?: string,
    authorAvatar?: string,
  ): Promise<FetchResult>;
  /** Optional platform-specific fallback request implementation. */
  fetchAjaxFallback?(
    channel: Channel,
    limit: number,
    page: number,
    options?: FetchOptions,
  ): Promise<FetchResult>;
  /** Optional platform-specific response normalizer. */
  parseGraphQLResult?(
    channel: Channel,
    tweetData: unknown,
    userData: unknown,
    limit: number,
    onlyOriginal?: boolean,
    bottomCursor?: string,
  ): FetchResult;
}

