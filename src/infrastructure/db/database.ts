import Dexie, { type Table } from 'dexie';
import type { Creator, Channel, Post, AppSettings, DeletedPostRecord } from '../../types';

export class FeedDatabase extends Dexie {
  creators!: Table<Creator, string>;
  channels!: Table<Channel, string>;
  posts!: Table<Post, string>;
  settings!: Table<{ key: string; value: any }, string>;
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
  }
}

export const db = new FeedDatabase();
