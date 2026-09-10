/**
 * Manual (drag-and-drop) ordering helpers.
 *
 * `sortOrder` is written only for creators the user has actually dragged, so
 * most records have none. Every comparison must therefore tolerate `undefined`
 * without producing NaN: `(undefined ?? Infinity) - (undefined ?? Infinity)` is
 * `Infinity - Infinity`, and a comparator returning NaN makes `Array#sort` leave
 * the array in an arbitrary order instead of falling back to the tiebreaker.
 */

/** Orders two `sortOrder` values; records without one sort after those with. */
export function compareManualOrder(a: number | undefined, b: number | undefined): number {
  if (a === b) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return a - b;
}

/**
 * The manual display order: explicit `sortOrder` first, then creation time so
 * the result is stable for records that share a value (or all lack one).
 */
export function compareManualEntries(
  a: { sortOrder?: number; createdAt?: number },
  b: { sortOrder?: number; createdAt?: number },
): number {
  const bySort = compareManualOrder(a.sortOrder, b.sortOrder);
  if (bySort !== 0) return bySort;
  return (a.createdAt || 0) - (b.createdAt || 0);
}

/**
 * Apply a drag result over a subset of the list.
 *
 * `orderedIds` is the new relative order of the items the user actually
 * reordered — which may be a *filtered* view, not the whole list. Writing
 * `0..n-1` straight from that list would collide with the indices still held by
 * the filtered-out items and leave the global order ambiguous. Instead the
 * reordered items are re-seated into the slots they already occupied: each one
 * keeps a distinct position, and every other item keeps its own.
 *
 * Returns the full list in its new order; callers that only need indices can
 * map over the result.
 */
export function reseatManualOrder<T extends { id: string }>(current: T[], orderedIds: string[]): T[] {
  const indexById = new Map(current.map((item, index) => [item.id, index]));
  const moving = orderedIds.filter((id) => indexById.has(id));
  if (moving.length === 0) return current;

  const movingSet = new Set(moving);
  // Positions currently held by the reordered items, ascending. Same length as
  // `moving` by construction, so the pairing below is always complete.
  const slots: number[] = [];
  for (let i = 0; i < current.length; i++) {
    if (movingSet.has(current[i].id)) slots.push(i);
  }

  const next = [...current];
  for (let i = 0; i < slots.length; i++) {
    next[slots[i]] = current[indexById.get(moving[i])!];
  }
  return next;
}
