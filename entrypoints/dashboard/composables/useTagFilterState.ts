import { ref } from 'vue';

/**
 * Tri-state tag filtering, shared by the feed and the creators directory.
 *
 * Both surfaces let the user click a tag chip through three states — neutral,
 * then (+) include, then (−) exclude, then back to neutral — and both filter by
 * the resulting two sets. The logic existed twice in full (once per composable)
 * plus a third copy of the same include/exclude predicate inside the creators
 * directory's own list. The duplicates were in one file before the
 * `CreatorsView` split; splitting did not cause them, it made them visible.
 *
 * Two things here are deliberate and easy to "simplify" wrongly:
 *
 *  - The sets are reassigned (`new Set(...)`), not merely mutated. Vue 3's
 *    reactivity does instrument `Set` methods, so mutation would usually work,
 *    but the reassignment is the pattern every call site has relied on since
 *    these were written, and a refactor that silently changes *when* a re-render
 *    is triggered is the kind of bug that shows up as a stale chip much later.
 *  - Exclude is evaluated BEFORE include, and the two are independent: a creator
 *    carrying an excluded tag is dropped even if it also carries an included one.
 *    Reading it as "include wins" would invert the meaning of the (−) state.
 */
export function useTagFilterState() {
  const includeTags = ref<Set<string>>(new Set());
  const excludeTags = ref<Set<string>>(new Set());

  /** Excluded tags take precedence over included ones. */
  function matchesTagFilter(tags: readonly string[] | undefined): boolean {
    const own = tags ?? [];
    if (excludeTags.value.size > 0 && own.some((t) => excludeTags.value.has(t))) return false;
    if (includeTags.value.size > 0 && !own.some((t) => includeTags.value.has(t))) return false;
    return true;
  }

  /** neutral → include (+) → exclude (−) → neutral */
  function cycleTagFilter(t: string) {
    if (includeTags.value.has(t)) {
      includeTags.value.delete(t);
      excludeTags.value.add(t);
    } else if (excludeTags.value.has(t)) {
      excludeTags.value.delete(t);
    } else {
      includeTags.value.add(t);
    }
    includeTags.value = new Set(includeTags.value);
    excludeTags.value = new Set(excludeTags.value);
  }

  function clearAllTagFilters() {
    includeTags.value = new Set();
    excludeTags.value = new Set();
  }

  /** Remove one tag from both sets, without touching the others. */
  function clearTagFromFilters(tag: string) {
    if (includeTags.value.has(tag) || excludeTags.value.has(tag)) {
      includeTags.value.delete(tag);
      excludeTags.value.delete(tag);
      includeTags.value = new Set(includeTags.value);
      excludeTags.value = new Set(excludeTags.value);
    }
  }

  function getTagFilterState(t: string): 'include' | 'exclude' | 'none' {
    if (includeTags.value.has(t)) return 'include';
    if (excludeTags.value.has(t)) return 'exclude';
    return 'none';
  }

  return {
    includeTags,
    excludeTags,
    matchesTagFilter,
    cycleTagFilter,
    clearAllTagFilters,
    clearTagFromFilters,
    getTagFilterState,
  };
}
