import type { Channel } from '../../types';
import { db } from './database';

/**
 * Upsert a channel record (channel id is `platform:accountId`, so binding the
 * same account twice overwrites instead of duplicating).
 */
export async function putChannel(channel: Channel): Promise<void> {
  await db.channels.put(channel);
}

/**
 * Delete a channel and every cached post belonging to it, in one
 * transaction. Tombstones in `deletedPostIds` are intentionally left
 * untouched (legacy behavior).
 */
export async function deleteChannelCascade(channelId: string): Promise<void> {
  await db.transaction('rw', [db.channels, db.posts], async () => {
    await db.channels.delete(channelId);
    await db.posts.where('channelId').equals(channelId).delete();
  });
}

/**
 * Persist a channel whose account role/label was already updated by the
 * caller and rewrite the denormalized `channelLabel` cache on all of its
 * posts so cards pick up the new label instantly.
 *
 * Caller contract (mirrors dashboard `cycleChannelRole`): mutate
 * `channel.accountRole` / `channel.label` first, then call this with the
 * whole channel — the full record is stored, nothing else is derived here.
 */
export async function updateChannelRole(channel: Channel): Promise<void> {
  await db.transaction('rw', [db.channels, db.posts], async () => {
    await db.channels.put(channel);
    await db.posts.where('channelId').equals(channel.id).modify({ channelLabel: channel.label });
  });
}
