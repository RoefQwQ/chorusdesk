import Dexie, { type Table, type Transaction } from 'dexie';
import type { Creator, Channel, Post, DeletedPostRecord } from '../../types';
import { stripTrailingTcoLink } from '../../utils/tco';

/**
 * Version 5: strip X's appended `t.co` link from stored tweets.
 *
 * The adapter now removes it at parse time, and `channelSync` repairs rows the
 * adapter returns — but a normal sync only ever returns the newest ~10 posts of a
 * channel, so a row older than that window is unreachable: it can never acquire a
 * fresh counterpart, and no UI action rewrites it either (force refresh replaces
 * what the adapter returns, which is the same newest-N). Observed on a real card:
 * a row still showing its link with a `4 小时前 同步` footer while a sync ran.
 *
 * Only rows WITH media are touched, and only a link at the very end of the text:
 * X appends one per medium, and without the entity list — which does not survive
 * in the database — an appended link is otherwise indistinguishable from one the
 * author typed. A row with no media is left alone, because there its link is the
 * author's content.
 */
export function stripStoredTweetLink(post: Post): void {
  if (post.platform !== 'twitter') return;
  if (!Array.isArray(post.mediaList) || post.mediaList.length === 0) return;
  post.content = stripTrailingTcoLink(post.content);
}

/**
 * The v5 upgrade body.
 *
 * Exported, and referenced by the migration test, so the rule under test is the
 * one that actually ships. The first version of that test declared its own copy
 * of this callback and therefore could not fail when the shipped rule was
 * weakened — a mutation removing the media gate left it green.
 */
export async function migrateStoredTweetLinks(tx: Transaction): Promise<void> {
  await tx.table('posts').toCollection().modify(stripStoredTweetLink);
  await tx.table('deletedPostIds').toCollection().modify((record: DeletedPostRecord) => {
    if (record.postData) stripStoredTweetLink(record.postData);
  });
}

export class FeedDatabase extends Dexie {
  creators!: Table<Creator, string>;
  channels!: Table<Channel, string>;
  posts!: Table<Post, string>;
  settings!: Table<{ key: string; value: unknown }, string>;
  deletedPostIds!: Table<DeletedPostRecord, string>;

  constructor() {
    super('CreatorFeedHubDB');
    this.version(1).stores({
      creators: 'id, name, *tags, createdAt, sortOrder',
      channels: 'id, creatorId, platform, accountId, status, lastCheckAt',
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked',
      settings: 'key',
    });
    // Version 2: Add compound index [channelId+publishedAt] for blazing fast channel queries & watermark checks
    this.version(2).stores({
      posts: 'id, creatorId, channelId, platform, publishedAt, fetchedAt, isRead, isBookmarked, [channelId+publishedAt]',
    });
    // Version 3: Add deletedPostIds store to record tombstoned post IDs
    this.version(3).stores({
      deletedPostIds: 'id, channelId, creatorId, deletedAt',
    });
    // Version 4: store isRead / isBookmarked as 0|1 instead of boolean.
    // IndexedDB rejects booleans as index keys, so boolean-valued rows were
    // never entered into the isRead / isBookmarked indexes declared in v1/v2 —
    // `where('isRead').equals(...)` matched nothing regardless of the queried
    // type, which left the unread badge blank and the bookmark stat at 0.
    // Rewriting every row re-indexes it. Tombstoned snapshots in
    // `deletedPostIds.postData` are migrated too: restoring an un-migrated
    // snapshot would reintroduce a row invisible to those indexes.
    this.version(4).upgrade(async (tx) => {
      await tx.table('posts').toCollection().modify((post: Post) => {
        post.isRead = post.isRead ? 1 : 0;
        post.isBookmarked = post.isBookmarked ? 1 : 0;
      });
      await tx.table('deletedPostIds').toCollection().modify((record: DeletedPostRecord) => {
        if (record.postData) {
          record.postData.isRead = record.postData.isRead ? 1 : 0;
          record.postData.isBookmarked = record.postData.isBookmarked ? 1 : 0;
        }
      });
    });
    this.version(5).upgrade(migrateStoredTweetLinks);
  }
}

export const db = new FeedDatabase();
