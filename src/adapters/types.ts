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
  | 'unsupported';

export interface FetchError {
  /** Machine-readable failure class; drives sync-layer policy, not display. */
  code: FetchErrorCode;
  /** Human-readable Chinese message, safe to surface in the UI as-is. */
  message: string;
}

export function fetchError(code: FetchErrorCode, message: string): FetchError {
  return { code, message };
}

export interface FetchResult {
  posts: Post[];
  authorMeta?: {
    name?: string;
    avatar?: string;
  };
  nextCursor?: string;
  /** False when the adapter knows there is nothing older to fetch. */
  hasMore?: boolean;
  error?: FetchError;
  /** Total raw posts returned by adapter in this batch before DB deduplication */
  totalFetched?: number;
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

