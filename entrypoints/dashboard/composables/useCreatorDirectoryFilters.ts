import { computed, ref } from 'vue';
import {
  PLATFORM_REGISTRY,
  ACCOUNT_ROLE_ORDER,
  type AccountRole,
  type Creator,
  type Channel,
} from '../../../src/types';
import { compareManualEntries } from '../../../src/utils/order';
import type { CreatorSortKey } from '../types/creatorDirectory';

/**
 * One entry of the sort dropdown.
 *
 * Declared here rather than imported from `AppSelect.vue`: a composable must not
 * depend on a component (the layering is the other way round), and the shape is
 * structurally what the generic `AppSelect` expects, so the call site still gets
 * `T` inferred as `CreatorSortKey`.
 */
export interface CreatorSortOption {
  value: CreatorSortKey;
  label: string;
}

/**
 * Sort key for the creators directory — declared in `types/creatorDirectory.ts`
 * alongside the view contracts that carry it, and re-exported here so existing
 * importers keep one entry point for the composable's own vocabulary.
 */
export type { CreatorSortKey };

export interface CreatorDirectoryDependencies {
  /** Live creator list (readers run inside computeds, so they must stay reactive). */
  creators: () => Creator[];
  /** Every bound platform account; the directory filters and counts read it. */
  channels: () => Channel[];
  /** creatorId -> post count (card statistics and the 作品数 sort). */
  creatorPostCountMap: () => Record<string, number>;
  /** User-defined platform order (the 按平台分组 sort reads it). */
  platformOrder: () => string[];
}

/**
 * Search, filters and sorting for the creators directory (`CreatorsView`).
 *
 * Everything here is *derived view state*: it reads the passed-in data and owns
 * no persistence and no side effects. The directory's own actions (sync, delete,
 * drag-reorder) stay in the view, which forwards them to the parent as emits.
 *
 * Moved verbatim out of `CreatorsView.vue` (2026-09-11) — the predicates,
 * comparator and tie-break are unchanged, and a byte-level render comparison of
 * the pre/post trees backs that claim.
 */
export function useCreatorDirectoryFilters(deps: CreatorDirectoryDependencies) {
  const creatorSearch = ref('');
  const creatorPlatformFilter = ref('all');
  /** Legacy single-tag filter, kept in the pipeline for API compatibility. */
  const creatorTagFilter = ref('all');
  /** Account-type filter: 'all' | AccountRole. A creator matches when any of its accounts has that role. */
  const creatorRoleFilter = ref<'all' | AccountRole>('all');
  const includeTags = ref<Set<string>>(new Set());
  const excludeTags = ref<Set<string>>(new Set());

  // Typed against `CreatorSortKey` so the generic `AppSelect` can prove the options
  // match the ref it is bound to: without the annotation Vue widens `value` to
  // `string`, and a typo here would be accepted silently.
  const creatorSortOptions: CreatorSortOption[] = [
    { value: 'updated', label: '最近活跃' },
    { value: 'posts', label: '作品数量' },
    { value: 'channels', label: '账号数量' },
    { value: 'name', label: '字母名称' },
    { value: 'tags', label: '标签' },
    { value: 'platform', label: '按平台分组' },
    { value: 'manual', label: '手动排序' },
  ];
  const creatorSortBy = ref<CreatorSortKey>('updated');
  const creatorSortDir = ref<'asc' | 'desc'>('desc');

  /** The direction a column should default to when first clicked. */
  function defaultSortDir(key: CreatorSortKey): 'asc' | 'desc' {
    // Text reads naturally A→Z; counts and timestamps are almost always wanted
    // largest/newest first.
    return key === 'name' || key === 'tags' ? 'asc' : 'desc';
  }

  /**
   * Header click: sort by that column, or flip the direction if already sorted by
   * it. Matches the behaviour every data table has, so it needs no learning.
   */
  function toggleSort(key: CreatorSortKey) {
    if (creatorSortBy.value === key) {
      creatorSortDir.value = creatorSortDir.value === 'asc' ? 'desc' : 'asc';
      return;
    }
    creatorSortBy.value = key;
    creatorSortDir.value = defaultSortDir(key);
  }

  /** True when `key` is the active sort column — the header that shows an arrow. */
  function isSortedBy(key: CreatorSortKey): boolean {
    return creatorSortBy.value === key;
  }

  /** `aria-sort` value for a header, per the W3C sortable-table pattern. */
  function ariaSortFor(key: CreatorSortKey): 'ascending' | 'descending' | 'none' {
    if (!isSortedBy(key)) return 'none';
    return creatorSortDir.value === 'asc' ? 'ascending' : 'descending';
  }

  /**
   * The toolbar dropdown's binding.
   *
   * Bound to the same state the headers write, so the two can never disagree, and
   * picking a key here also applies that key's natural direction — otherwise
   * choosing 「字母名称」 after sorting by 作品数 would silently give Z→A.
   */
  const sortSelection = computed<CreatorSortKey>({
    get: () => creatorSortBy.value,
    set: (key) => {
      creatorSortBy.value = key;
      creatorSortDir.value = defaultSortDir(key);
    },
  });

  // All available tags
  const allTags = computed(() => {
    const set = new Set<string>();
    deps.creators().forEach(c => c.tags?.forEach(t => set.add(t)));
    return Array.from(set);
  });

  // Tag filtering tri-state helpers (neutral -> include -> exclude -> neutral)
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

  function getTagFilterState(t: string): 'include' | 'exclude' | 'none' {
    if (includeTags.value.has(t)) return 'include';
    if (excludeTags.value.has(t)) return 'exclude';
    return 'none';
  }

  // Platform count map per creator
  const creatorChannelMap = computed(() => {
    const map: Record<string, Channel[]> = {};
    for (const ch of deps.channels()) {
      if (!map[ch.creatorId]) map[ch.creatorId] = [];
      map[ch.creatorId].push(ch);
    }
    return map;
  });

  // Creators per account role (filter pill badges) — counts creators, not channels.
  const creatorCountByRole = computed<Record<string, number>>(() => {
    const counts: Record<string, number> = { all: deps.creators().length };
    for (const role of ACCOUNT_ROLE_ORDER) counts[role] = 0;
    for (const c of deps.creators()) {
      const roles = new Set(
        deps.channels().filter(ch => ch.creatorId === c.id).map(ch => ch.accountRole || 'main')
      );
      for (const r of roles) counts[r] = (counts[r] || 0) + 1;
    }
    return counts;
  });

  // Filtered and sorted creators list for Directory tab
  const filteredCreatorsList = computed(() => {
    let list = [...deps.creators()];

    // 1. Search filter (matches creator name, tag, or channel account/displayName)
    if (creatorSearch.value.trim()) {
      const q = creatorSearch.value.trim().toLowerCase();
      list = list.filter(c => {
        const matchName = (c.name || '').toLowerCase().includes(q);
        const matchTag = c.tags?.some(t => t.toLowerCase().includes(q));
        const matchCh = deps.channels().some(
          ch => ch.creatorId === c.id && ((ch.displayName || '').toLowerCase().includes(q) || ch.accountId.toLowerCase().includes(q))
        );
        return matchName || matchTag || matchCh;
      });
    }

    // 2. Platform filter
    if (creatorPlatformFilter.value !== 'all') {
      list = list.filter(c => {
        return deps.channels().some(ch => ch.creatorId === c.id && ch.platform === creatorPlatformFilter.value);
      });
    }

    // 3. Tag filter (positive inclusion & negative exclusion)
    if (excludeTags.value.size > 0) {
      list = list.filter(c => {
        const cTags = c.tags || [];
        return !cTags.some(t => excludeTags.value.has(t));
      });
    }
    if (includeTags.value.size > 0) {
      list = list.filter(c => {
        const cTags = c.tags || [];
        return cTags.some(t => includeTags.value.has(t));
      });
    }
    if (creatorTagFilter.value !== 'all') {
      list = list.filter(c => c.tags?.includes(creatorTagFilter.value));
    }

    // 4. Account-type filter: creator has at least one channel of that role.
    if (creatorRoleFilter.value !== 'all') {
      list = list.filter(c =>
        deps.channels().some(ch => ch.creatorId === c.id && (ch.accountRole || 'main') === creatorRoleFilter.value)
      );
    }

    // 5. Sorting
    const channelCount = (c: Creator) => (creatorChannelMap.value[c.id] || []).length;
    const postCount = (c: Creator) => deps.creatorPostCountMap()[c.id] || 0;
    const lastActive = (c: Creator) =>
      Math.max(c.updatedAt || 0, ...(creatorChannelMap.value[c.id] || []).map((ch) => ch.lastCheckAt || 0));

    list.sort((a, b) => {
      if (creatorSortBy.value === 'platform') {
        // Group by the creator's first platform (in user's sidebar order),
        // newest-active within the group.
        const rank = (c: Creator) => {
          const platforms = (creatorChannelMap.value[c.id] || []).map((ch) => ch.platform);
          const order = deps.platformOrder().length > 0 ? deps.platformOrder() : Object.keys(PLATFORM_REGISTRY);
          let best = order.length;
          for (const p of platforms) {
            const i = order.indexOf(p);
            if (i !== -1 && i < best) best = i;
          }
          return best;
        };
        const byRank = rank(a) - rank(b);
        if (byRank !== 0) return byRank;
        return lastActive(b) - lastActive(a);
      }
      if (creatorSortBy.value === 'manual') {
        // Shared with the persistence layer; must not return NaN when both
        // records lack a sortOrder (the pre-drag state of every creator).
        return compareManualEntries(a, b);
      }

      // Column sorts. Each branch states its comparison in ascending terms and the
      // direction is applied once, so adding a column cannot forget the arrow.
      let ascending: number;
      switch (creatorSortBy.value) {
        case 'name':
          ascending = (a.name || '').localeCompare(b.name || '', 'zh');
          break;
        case 'tags':
          ascending = ((a.tags || [])[0] || '').localeCompare((b.tags || [])[0] || '', 'zh');
          break;
        case 'channels':
          ascending = channelCount(a) - channelCount(b);
          break;
        case 'posts':
          ascending = postCount(a) - postCount(b);
          break;
        default:
          ascending = lastActive(a) - lastActive(b);
      }
      // A stable tie-break keeps the order deterministic between renders; without
      // it, rows with equal keys shuffle as the list re-sorts.
      if (ascending === 0) return (a.name || '').localeCompare(b.name || '', 'zh');
      return creatorSortDir.value === 'asc' ? ascending : -ascending;
    });

    return list;
  });

  return {
    creatorSearch,
    creatorPlatformFilter,
    creatorTagFilter,
    creatorRoleFilter,
    includeTags,
    excludeTags,
    creatorSortOptions,
    creatorSortBy,
    creatorSortDir,
    sortSelection,
    toggleSort,
    isSortedBy,
    ariaSortFor,
    allTags,
    cycleTagFilter,
    clearAllTagFilters,
    getTagFilterState,
    creatorChannelMap,
    creatorCountByRole,
    filteredCreatorsList,
  };
}

export type CreatorDirectoryState = ReturnType<typeof useCreatorDirectoryFilters>;
