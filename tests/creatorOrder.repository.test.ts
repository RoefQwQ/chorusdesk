import { beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { db } from '../src/infrastructure/db/database';
import { putCreator, updateCreatorsSortOrder } from '../src/infrastructure/db/creatorRepository';
import { compareManualEntries } from '../src/utils/order';
import type { Creator } from '../src/types';

/**
 * Persistence contract for drag-ordered creators.
 *
 * The bug this guards: the directory can be filtered (by platform, tag, role,
 * search) while dragging. The old writer stamped `0..n-1` onto the reordered
 * ids it was handed, so a drag inside a filtered view handed the moved creators
 * indices that collided with the ones still held by the hidden creators — the
 * global order then depended on which filter happened to be active.
 *
 * The assertion is deliberately about the *whole* list, not the visible part.
 */

function makeCreator(id: string, createdAt: number, sortOrder?: number): Creator {
  return {
    id,
    name: id.toUpperCase(),
    avatar: '',
    tags: [],
    createdAt,
    updatedAt: createdAt,
    ...(sortOrder === undefined ? {} : { sortOrder }),
  };
}

/** The list in the order the manual mode would display it. */
async function displayOrder(): Promise<string[]> {
  const all = await db.creators.toArray();
  return [...all].sort(compareManualEntries).map((c) => c.id);
}

beforeEach(async () => {
  await db.open();
  await db.creators.clear();
});

describe('updateCreatorsSortOrder', () => {
  it('applies a full-list drag', async () => {
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await putCreator(makeCreator(id, (i + 1) * 1000));
    }

    await updateCreatorsSortOrder(['c', 'a', 'b']);

    await expect(displayOrder()).resolves.toEqual(['c', 'a', 'b']);
  });

  it('keeps the global order well defined when only a filtered subset is dragged', async () => {
    for (const [i, id] of ['a', 'b', 'c', 'd', 'e'].entries()) {
      await putCreator(makeCreator(id, (i + 1) * 1000));
    }
    // Baseline: creation order.
    await expect(displayOrder()).resolves.toEqual(['a', 'b', 'c', 'd', 'e']);

    // The user filtered down to b, d, e and dragged e to the front.
    await updateCreatorsSortOrder(['e', 'b', 'd']);

    const order = await displayOrder();
    // Every creator holds a distinct slot...
    expect(new Set(order).size).toBe(5);
    // ...the dragged subset honours the new relative order...
    expect(order.filter((id) => ['b', 'd', 'e'].includes(id))).toEqual(['e', 'b', 'd']);
    // ...and the creators that were never on screen kept their exact slots.
    expect(order[0]).toBe('a');
    expect(order[2]).toBe('c');
  });

  it('is stable across repeated identical drags', async () => {
    for (const [i, id] of ['a', 'b', 'c'].entries()) {
      await putCreator(makeCreator(id, (i + 1) * 1000));
    }

    await updateCreatorsSortOrder(['b', 'a', 'c']);
    const first = await displayOrder();
    await updateCreatorsSortOrder(['b', 'a', 'c']);

    await expect(displayOrder()).resolves.toEqual(first);
  });

  it('leaves updatedAt alone so the "recently active" sort is unaffected', async () => {
    await putCreator(makeCreator('a', 1000));
    await putCreator(makeCreator('b', 2000));

    await updateCreatorsSortOrder(['b', 'a']);

    const a = await db.creators.get('a');
    const b = await db.creators.get('b');
    expect(a?.updatedAt).toBe(1000);
    expect(b?.updatedAt).toBe(2000);
  });
});
