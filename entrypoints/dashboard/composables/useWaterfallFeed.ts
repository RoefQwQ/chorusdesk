import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { Post } from '../../../src/types';

/** Posts added per infinite-scroll step. */
const PAGE_SIZE = 36;

/**
 * The feed's pagination and its responsive masonry layout.
 *
 * Extracted from `FeedView.vue` (2026-09-11). The two are one piece of work, not
 * two: the observer grows `visibleCount`, `paginatedPosts` slices with it, and
 * `feedColumns` packs that slice — splitting them would put the pagination window
 * and the thing that displays it in different files.
 *
 * Three behaviours here are load-bearing and easy to lose in a rewrite:
 *
 *  - **The page resets whenever the result set changes** (`filteredPosts.length`).
 *    Without it, switching a filter while scrolled down leaves `visibleCount` at
 *    its grown value, which is invisible until the list is long enough to show the
 *    difference — the previous filter's page window applies to the new list.
 *  - **The observer's margin is 900px**, i.e. it starts loading well before the
 *    sentinel reaches the viewport. A guard's whole value can be a magnitude
 *    (AGENTS rule 24), so it is asserted rather than assumed.
 *  - **Columns are packed by estimated height, tallest-first-fit**: each post goes
 *    to the currently shortest column. That is what makes the waterfall look even
 *    rather than filling one column before the next.
 *
 * The listener and the observer are registered and torn down here; the view keeps
 * no lifecycle code for either.
 */
export function useWaterfallFeed(deps: {
  /** The filtered posts to lay out. A reader, so the computeds stay reactive. */
  posts: () => Post[];
}) {
  const visibleCount = ref(PAGE_SIZE);
  const infiniteScrollTrigger = ref<HTMLElement | null>(null);
  let scrollObserver: IntersectionObserver | null = null;

  // Reset paging whenever the filtered result set changes (new sync/filter).
  watch(
    () => deps.posts().length,
    () => {
      visibleCount.value = PAGE_SIZE;
    }
  );

  function setupScrollObserver() {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
    if (typeof window === 'undefined' || !('IntersectionObserver' in window)) return;
    scrollObserver = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry && entry.isIntersecting) {
          if (visibleCount.value < deps.posts().length) {
            visibleCount.value += PAGE_SIZE;
          }
        }
      },
      { rootMargin: '900px 0px' }
    );
    if (infiniteScrollTrigger.value) {
      scrollObserver.observe(infiniteScrollTrigger.value);
    }
  }

  watch(infiniteScrollTrigger, (el) => {
    if (el && scrollObserver) {
      scrollObserver.observe(el);
    }
  });

  const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1200);
  const columnCount = computed(() => {
    if (windowWidth.value < 768) return 1; // mobile: single column
    if (windowWidth.value < 1280) return 2; // tablet: 2 columns
    return 3; // desktop: 3 columns
  });

  function handleResizeForWaterfall() {
    windowWidth.value = window.innerWidth;
  }

  function estimatePostHeight(p: Post): number {
    let h = 90; // Header avatar + meta info + padding
    if (p.title) h += 28;
    if (p.content) {
      const lines = Math.min(Math.ceil(p.content.length / 32), 4);
      h += lines * 18;
    }
    if (p.mediaList?.length) {
      if (p.mediaList.length === 1) {
        h += p.mediaList[0].type === 'video' ? 210 : 320;
      } else if (p.mediaList.length === 2) {
        h += 220;
      } else {
        h += 260;
      }
    }
    h += 40; // Footer timestamp + direct link bar
    return h;
  }

  const paginatedPosts = computed(() => deps.posts().slice(0, Math.max(1, visibleCount.value)));

  const feedColumns = computed(() => {
    const count = Math.max(1, columnCount.value);
    const cols: Post[][] = Array.from({ length: count }, () => []);
    const colHeights = new Array<number>(count).fill(0);
    for (const post of paginatedPosts.value) {
      let minCol = 0;
      for (let c = 1; c < count; c++) {
        if (colHeights[c] < colHeights[minCol]) minCol = c;
      }
      cols[minCol].push(post);
      colHeights[minCol] += estimatePostHeight(post) + 20;
    }
    return cols;
  });

  onMounted(() => {
    window.addEventListener('resize', handleResizeForWaterfall);
    nextTick(setupScrollObserver);
  });
  onUnmounted(() => {
    window.removeEventListener('resize', handleResizeForWaterfall);
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
  });

  return {
    PAGE_SIZE,
    visibleCount,
    infiniteScrollTrigger,
    paginatedPosts,
    feedColumns,
    columnCount,
    estimatePostHeight,
  };
}
