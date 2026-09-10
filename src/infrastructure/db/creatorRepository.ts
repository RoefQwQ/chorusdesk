import type { Creator } from '../../types';
import { compareManualEntries, reseatManualOrder } from '../../utils/order';
import { db } from './database';

/**
 * Upsert a creator record (same key overwrites). UI "add creator" flows use a
 * freshly generated unique id, so `put` (not `add`) keeps demo/seed data and
 * re-syncs idempotent — same semantics as the legacy `db.creators.put`.
 */
export async function putCreator(creator: Creator): Promise<void> {
  await db.creators.put(creator);
}

/**
 * Partial update of a single creator record (e.g. avatar write-back / avatar
 * picker). Mirrors legacy `db.creators.update(id, changes)` calls.
 */
export async function updateCreatorRecord(id: string, changes: Partial<Creator>): Promise<void> {
  await db.creators.update(id, changes);
}

/**
 * Delete a creator together with every bound channel and all of that
 * channel's cached posts, in one transaction. Tombstones in
 * `deletedPostIds` are intentionally left untouched (legacy behavior).
 */
export async function deleteCreatorCascade(creatorId: string): Promise<void> {
  await db.transaction('rw', [db.creators, db.channels, db.posts], async () => {
    await db.creators.delete(creatorId);
    const channels = await db.channels.where('creatorId').equals(creatorId).toArray();
    for (const channel of channels) {
      await db.channels.delete(channel.id);
      await db.posts.where('channelId').equals(channel.id).delete();
    }
  });
}

/**
 * Replace a creator's tag list and refresh its `updatedAt` timestamp
 * (defaults to now, matching the dashboard tags editor).
 */
export async function updateCreatorTagsRecord(id: string, tags: string[], updatedAt = Date.now()): Promise<void> {
  await db.creators.update(id, { tags, updatedAt });
}

/**
 * Remove one tag from every creator that carries it, refreshing `updatedAt`.
 * This is the library-wide tag sweep behind the dashboard "delete global tag"
 * action; returns the number of creators that were updated.
 */
export async function removeGlobalTag(tagToRemove: string): Promise<number> {
  const allCreators = await db.creators.toArray();
  let updated = 0;
  for (const c of allCreators) {
    if (c.tags && c.tags.includes(tagToRemove)) {
      const updatedTags = c.tags.filter(t => t !== tagToRemove);
      await db.creators.update(c.id, { tags: updatedTags, updatedAt: Date.now() });
      updated++;
    }
  }
  return updated;
}

/**
 * Persist a manual creator order.
 *
 * `orderedIds` is the new order of the creators the user dragged, which may be
 * a filtered subset of the directory. The reordered items are re-seated into
 * the slots they already occupied (see `reseatManualOrder`) and the whole list
 * is then written with explicit indices, so the result is unambiguous no matter
 * which filter was active during the drag.
 *
 * `sortOrder` is display-only: `updatedAt` is left alone so reordering never
 * reshuffles the "recently active" sort as a side effect.
 */
export async function updateCreatorsSortOrder(orderedIds: string[]): Promise<void> {
  await db.transaction('rw', db.creators, async () => {
    const all = await db.creators.toArray();
    const ordered = reseatManualOrder(
      [...all].sort(compareManualEntries),
      orderedIds,
    );
    for (let i = 0; i < ordered.length; i++) {
      if (ordered[i].sortOrder === i) continue;
      await db.creators.update(ordered[i].id, { sortOrder: i });
    }
  });
}
