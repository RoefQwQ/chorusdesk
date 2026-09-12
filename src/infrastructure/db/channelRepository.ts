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
 * Delete a channel and every cached post belonging to it, in one transaction.
 *
 * Recycle snapshots under this channel go with it (I12: a snapshot whose parent
 * is gone can never be restored into a working feed, and leaving it produces a
 * 「动态已定向找回」 that writes a dangling row). Suppressions are deliberately
 * KEPT — a re-follow must not resurrect what the user deleted (I9, §6 问题 5).
 */
export async function deleteChannelCascade(channelId: string): Promise<void> {
  await db.transaction('rw', [db.channels, db.posts, db.recycleSnapshots], async () => {
    await db.channels.delete(channelId);
    await db.posts.where('channelId').equals(channelId).delete();
    await db.recycleSnapshots.where('channelId').equals(channelId).delete();
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

/**
 * Reset every channel left mid-sync back to `idle`.
 *
 * A sync sets `updating` before it starts and clears it when it finishes, so a
 * browser close or an MV3 worker teardown in between leaves the row claiming to
 * be syncing forever — the badge then says 同步中 for a run that no longer exists.
 * Called on dashboard boot and on popup open.
 *
 * Lives in the db layer, not in `src/sync`: it is a plain channel write with no
 * adapter involved, and while it lived beside `channelSync` every caller had to
 * pull in the platform registry to reset a status column. The popup, which calls
 * this on open, was loading all ten adapters to do it.
 *
 * Only rows whose status is `updating` are touched, and `errorMessage` is left
 * alone: a genuinely failed channel keeps both its status and the message that
 * explains it.
 */
export async function clearStaleUpdatingStatus(): Promise<void> {
  try {
    await db.channels.where('status').equals('updating').modify({
      status: 'idle',
    });
  } catch (e) {
    console.warn('[Channels] Failed to clear stale updating status:', e);
  }
}