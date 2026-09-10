import { describe, expect, it } from 'vitest';
import { compareManualEntries, compareManualOrder, reseatManualOrder } from '../src/utils/order';

/**
 * Regression test for the manual (drag) ordering added in the third
 * real-Chrome round.
 *
 * Two defects are pinned here:
 *  1. The comparator used `(a.sortOrder ?? Infinity) - (b.sortOrder ?? Infinity)`
 *     and returned early when the result was non-zero. With every creator
 *     lacking a `sortOrder` — which is the state before the first drag — that is
 *     `Infinity - Infinity` = NaN, and a NaN comparator makes `Array#sort` skip
 *     the tiebreaker entirely and leave the list in an arbitrary order.
 *  2. Persisting wrote `0..n-1` for the *visible* list only. Dragging inside a
 *     filtered view therefore handed out indices that collided with the ones
 *     held by the hidden creators, leaving the global order ambiguous.
 */

describe('compareManualOrder', () => {
  it('never returns NaN when both values are missing', () => {
    expect(compareManualOrder(undefined, undefined)).toBe(0);
    expect(compareManualOrder(0, 0)).toBe(0);
  });

  it('sorts ordered records first, unordered ones last', () => {
    expect(compareManualOrder(2, 5)).toBeLessThan(0);
    expect(compareManualOrder(5, 2)).toBeGreaterThan(0);
    expect(compareManualOrder(3, undefined)).toBeLessThan(0);
    expect(compareManualOrder(undefined, 3)).toBeGreaterThan(0);
  });

  it('keeps identical values equal so the caller can tiebreak', () => {
    expect(compareManualOrder(4, 4)).toBe(0);
  });
});

describe('compareManualEntries', () => {
  it('falls back to creation time for records without a sortOrder', () => {
    const older = { id: 'a', createdAt: 100 };
    const newer = { id: 'b', createdAt: 200 };
    expect(compareManualEntries(older, newer)).toBeLessThan(0);
  });

  it('uses sortOrder in preference to creation time', () => {
    const olderButFirst = { sortOrder: 0, createdAt: 500 };
    const newerButSecond = { sortOrder: 1, createdAt: 100 };
    expect(compareManualEntries(olderButFirst, newerButSecond)).toBeLessThan(0);
  });

  it('actually produces a deterministic order for a fresh, unsorted list', () => {
    // The pre-drag state: no sortOrder anywhere.
    const list = [
      { id: 'c', createdAt: 300 },
      { id: 'a', createdAt: 100 },
      { id: 'b', createdAt: 200 },
    ];
    expect([...list].sort(compareManualEntries).map((x) => x.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('reseatManualOrder', () => {
  const full = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }];

  it('moves a dragged item to its new position', () => {
    // Drag 'a' below 'c'.
    expect(reseatManualOrder(full, ['b', 'c', 'a', 'd', 'e']).map((x) => x.id)).toEqual([
      'b', 'c', 'a', 'd', 'e',
    ]);
  });

  it('re-orders a filtered subset only within the slots that subset occupies', () => {
    // Only b, d, e are visible; the user drags e to the front of that view.
    const next = reseatManualOrder(full, ['e', 'b', 'd']).map((x) => x.id);
    // The visible relative order is honoured (e before b before d) and the
    // hidden a/c keep their positions rather than colliding with the moved ids.
    const visible = next.filter((id) => ['b', 'd', 'e'].includes(id));
    expect(visible).toEqual(['e', 'b', 'd']);
    expect(next[0]).toBe('a');
    expect(next[2]).toBe('c');
  });

  it('is a no-op for an empty or entirely unknown id list', () => {
    expect(reseatManualOrder(full, [])).toBe(full);
    expect(reseatManualOrder(full, ['zzz'])).toBe(full);
  });

  it('ignores ids that are not in the current list', () => {
    expect(reseatManualOrder(full, ['c', 'zzz', 'a']).map((x) => x.id)).toEqual([
      'c', 'b', 'a', 'd', 'e',
    ]);
  });

  it('assigns every item a distinct position', () => {
    const next = reseatManualOrder(full, ['e', 'd', 'c', 'b', 'a']);
    expect(new Set(next.map((x) => x.id)).size).toBe(full.length);
    expect(next.map((x) => x.id)).toEqual(['e', 'd', 'c', 'b', 'a']);
  });
});
