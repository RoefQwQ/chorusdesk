import { computed, ref, type Ref, type ShallowRef } from 'vue';
import type { Creator, Channel, Post, AppSettings } from '../../../src/types';
import { saveSettings } from '../../../src/infrastructure/db/settingsRepository';

export interface FeedFilterDependencies {
  posts: ShallowRef<Post[]>;
  creators: Ref<Creator[]>;
  channels: Ref<Channel[]>;
  /** Hidden-creator preference sets (localStorage-backed UI state). */
  hiddenCreatorIds: Ref<Set<string>>;
  hiddenCreatorPlatforms: Ref<Record<string, string[]>>;
  /** Live settings — hideReposts/hideTextOnly persisted through it. */
  settings: Ref<AppSettings>;
}

/**
 * Feed filtering & visibility state for the Dashboard: search query, platform
 * selection, include/exclude tag tri-state filters, repost/text-only
 * preferences and the derived filtered-post / creator lists. These are the
 * exact computeds the former App.vue exposed to FeedView — moved without
 * behavior change, with persistence through settingsRepository.
 */
export function useFeedFilters(deps: FeedFilterDependencies) {
  const { posts, creators, channels, hiddenCreatorIds, hiddenCreatorPlatforms, settings } = deps;

  const searchQuery = ref('');
  const selectedPlatform = ref<string>('all');
  const selectedTag = ref<string>('all'); // Legacy backward compatibility
  const includeTags = ref<Set<string>>(new Set());
  const excludeTags = ref<Set<string>>(new Set());
  const hideReposts = ref(false);
  const hideTextOnly = ref(false);

  const creatorMap = computed(() => new Map(creators.value.map(creator => [creator.id, creator])));

  // All available tags
  const allTags = computed(() => {
    const set = new Set<string>();
    creators.value.forEach(c => c.tags?.forEach(t => set.add(t)));
    return Array.from(set);
  });

  // Repost/Retweet detector & filter helper
  function isRepostPost(p: Post): boolean {
    if (p.isRepost !== undefined) return p.isRepost;
    // Fallback signatures for existing database posts
    if (p.platform === 'twitter') {
      if (p.content?.startsWith('[转推') || p.title?.includes('的转推') || p.content?.startsWith('RT @')) return true;
    }
    if (p.platform === 'bilibili') {
      if (p.content?.includes('//转发自') || p.content?.startsWith('//@') || p.title?.includes('转发动态')) return true;
    }
    return false;
  }

  const repostsCount = computed(() => {
    return posts.value.filter(isRepostPost).length;
  });

  async function toggleHideReposts() {
    hideReposts.value = !hideReposts.value;
    settings.value.hideReposts = hideReposts.value;
    await saveSettings({ hideReposts: hideReposts.value });
  }

  // Text-only post detector & filter helper (posts with no images, videos or audio)
  function isTextOnlyPost(p: Post): boolean {
    return !p.mediaList || p.mediaList.length === 0;
  }

  const textOnlyCount = computed(() => {
    return posts.value.filter(isTextOnlyPost).length;
  });

  async function toggleHideTextOnly() {
    hideTextOnly.value = !hideTextOnly.value;
    settings.value.hideTextOnly = hideTextOnly.value;
    await saveSettings({ hideTextOnly: hideTextOnly.value });
  }

  // Tag filtering tri-state helpers (neutral -> include -> exclude -> neutral)
  function cycleTagFilter(t: string) {
    if (includeTags.value.has(t)) {
      // Switch from include (+) to exclude (-)
      includeTags.value.delete(t);
      excludeTags.value.add(t);
    } else if (excludeTags.value.has(t)) {
      // Switch from exclude (-) to neutral (off)
      excludeTags.value.delete(t);
    } else {
      // Switch from neutral to include (+)
      includeTags.value.add(t);
    }
    includeTags.value = new Set(includeTags.value);
    excludeTags.value = new Set(excludeTags.value);
  }

  function clearAllTagFilters() {
    includeTags.value = new Set();
    excludeTags.value = new Set();
    selectedTag.value = 'all';
  }

  /** Remove a single tag from both tri-state filters (global tag purge). */
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

  // Visible creators under currently selected platform and tag filter
  const visibleCreatorsForFilter = computed(() => {
    return creators.value.filter(c => {
      const cTags = c.tags || [];
      // 1. Exclude tags check (if creator has ANY tag in excludeTags, hide)
      if (excludeTags.value.size > 0) {
        if (cTags.some(t => excludeTags.value.has(t))) return false;
      }
      // 2. Include tags check (creator must match at least one tag in includeTags)
      if (includeTags.value.size > 0) {
        if (!cTags.some(t => includeTags.value.has(t))) return false;
      }
      // 3. Platform filter
      if (selectedPlatform.value !== 'all') {
        const hasPlatformChannel = channels.value.some(
          ch => ch.creatorId === c.id && ch.platform === selectedPlatform.value
        );
        if (!hasPlatformChannel) return false;
      }
      return true;
    });
  });

  // Count of hidden creators currently visible in filter
  const hiddenCreatorsInFilterCount = computed(() => {
    return visibleCreatorsForFilter.value.filter(c => hiddenCreatorIds.value.has(c.id)).length;
  });

  // Post count map per platform for left sidebar badge
  const platformPostCounts = computed(() => {
    const counts: Record<string, number> = { all: posts.value.length };
    for (const p of posts.value) {
      counts[p.platform] = (counts[p.platform] || 0) + 1;
    }
    return counts;
  });

  // Filtered posts
  const filteredPosts = computed(() => {
    return posts.value.filter(p => {
      // 1. Check if creator is completely hidden
      if (hiddenCreatorIds.value.has(p.creatorId)) {
        return false;
      }

      // 2. Check if this specific platform of this creator is hidden (ONLY active when in "all platforms" view)
      if (selectedPlatform.value === 'all') {
        const hiddenPlatforms = hiddenCreatorPlatforms.value[p.creatorId];
        if (hiddenPlatforms && hiddenPlatforms.includes(p.platform)) {
          return false;
        }
      }

      // Repost filter
      if (hideReposts.value && isRepostPost(p)) {
        return false;
      }
      // Text-only filter (hide posts without media)
      if (hideTextOnly.value && isTextOnlyPost(p)) {
        return false;
      }
      // Platform filter
      if (selectedPlatform.value !== 'all' && p.platform !== selectedPlatform.value) {
        return false;
      }
      // Tag filter (positive inclusion & negative exclusion)
      const creator = creatorMap.value.get(p.creatorId);
      const cTags = creator?.tags || [];
      if (excludeTags.value.size > 0) {
        if (cTags.some(t => excludeTags.value.has(t))) {
          return false;
        }
      }
      if (includeTags.value.size > 0) {
        if (!cTags.some(t => includeTags.value.has(t))) {
          return false;
        }
      }
      // Search query
      if (searchQuery.value.trim()) {
        const q = searchQuery.value.toLowerCase();
        const matchText = (p.title || '').toLowerCase().includes(q) || p.content.toLowerCase().includes(q);
        const matchAuthor = creator?.name.toLowerCase().includes(q);
        if (!matchText && !matchAuthor) return false;
      }
      return true;
    });
  });

  return {
    searchQuery,
    selectedPlatform,
    selectedTag,
    includeTags,
    excludeTags,
    hideReposts,
    hideTextOnly,
    allTags,
    repostsCount,
    textOnlyCount,
    isRepostPost,
    isTextOnlyPost,
    toggleHideReposts,
    toggleHideTextOnly,
    cycleTagFilter,
    clearAllTagFilters,
    clearTagFromFilters,
    getTagFilterState,
    visibleCreatorsForFilter,
    hiddenCreatorsInFilterCount,
    platformPostCounts,
    filteredPosts,
  };
}
