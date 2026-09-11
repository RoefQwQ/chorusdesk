// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import FeedView from '../entrypoints/dashboard/views/FeedView.vue';

/**
 * The feed's two sidebars, which want different scrollers (2026-09-11):
 *
 * - the **right** creator list wraps around seamlessly and its height is draggable
 *   between 4 and 8 rows;
 * - the **left** platform list only has to scroll — the user's words: 「左侧的不需要
 *   无头滚动，只需要能上下滚动即可」.
 *
 * Asserted against the real `FeedView`, because that is where the two are wired and
 * where they could be swapped or mis-nested. `LoopScroll`'s own behaviour is covered
 * in `loopScroll.test.ts`; this only pins which configuration each column got.
 *
 * The distinguishing observations are the ones with real consequences: whether the
 * rows are rendered twice (that duplication *is* the wrap mechanism), and whether a
 * drag grip exists.
 */

/** The minimum context surface `FeedView` reads while rendering. */
function feedContext(creatorCount: number) {
  const noop = () => undefined;
  const creators = Array.from({ length: creatorCount }, (_, i) => ({
    id: `c${i + 1}`,
    name: `创作者${i + 1}`,
    avatar: '',
    tags: [],
    createdAt: 1,
    updatedAt: 1,
  }));
  return {
    PLATFORM_REGISTRY: {
      bilibili: { key: 'bilibili', name: '哔哩哔哩', color: '#00AEEC' },
      twitter: { key: 'twitter', name: 'X (Twitter)', color: '#1DA1F2' },
    },
    platformOrder: [],
    selectedPlatform: 'all',
    platformPostCounts: { all: 10, bilibili: 6, twitter: 4 },
    creators,
    channels: [],
    filteredPosts: [],
    visibleCount: 0,
    searchQuery: '',
    hideReposts: false,
    hideTextOnly: false,
    repostsCount: 0,
    textOnlyCount: 0,
    allTags: [],
    includeTags: new Set<string>(),
    excludeTags: new Set<string>(),
    visibleCreatorsForFilter: creators,
    hiddenCreatorsInFilterCount: 0,
    hiddenCreatorIds: new Set<string>(),
    hiddenCreatorPlatforms: {},
    expandedCreatorIds: new Set<string>(),
    syncingChannelIds: new Set<string>(),
    getCreatorAvatar: () => '',
    handleAvatarError: noop,
    getCreatorPlatforms: () => ['bilibili'],
    toggleExpandCreator: noop,
    toggleHideCreator: noop,
    unhideAllCreators: noop,
    clearAllTagFilters: noop,
    cycleTagFilter: noop,
    getTagFilterState: () => 'neutral',
    toggleHideReposts: noop,
    toggleHideTextOnly: noop,
    loadDemoData: noop,
    openAddModal: noop,
    handleDeletePost: noop,
    toggleBookmarkPost: noop,
    markPostRead: noop,
    onOpenReader: noop,
    toggleHideCreatorPlatform: noop,
    resetCreatorHiddenPlatforms: noop,
  };
}

let app: App | null = null;
let host: HTMLElement | null = null;

async function mountFeed(creatorCount = 10): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(FeedView as never, { context: feedContext(creatorCount) } as never);
  app.mount(host);
  await nextTick();
}

/** The scroller registered under the given accessible name. */
function scroller(label: string): HTMLElement {
  return host!.querySelector(`[role="group"][aria-label="${label}"]`) as HTMLElement;
}

beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: () => null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('feed sidebars — scroller configuration', () => {
  it('gives each sidebar a scroller', async () => {
    await mountFeed();
    expect(scroller('创作者列表')).not.toBeNull();
    expect(scroller('平台列表')).not.toBeNull();
  });

  it('renders every creator as one row of the first copy', async () => {
    // The copy count itself cannot be asserted here: `LoopScroll` only renders the
    // second copy once it has *measured* that one copy overflows the viewport, and
    // jsdom reports every height as 0. The duplication is therefore verified in a
    // real browser, together with the seam — see AGENTS rule 28. What is checkable
    // here is that each copy is fed every creator exactly once, structurally.
    await mountFeed(10);
    const copies = [...scroller('创作者列表').children];

    expect(copies.length).toBeGreaterThanOrEqual(1);
    expect(copies[0].children.length).toBe(10);
    // Rows are wrapped by the slot, so the creator name appears once per row.
    const names = [...copies[0].children].map((row) => row.textContent || '');
    expect(names.filter((t) => t.includes('创作者3')).length).toBe(1);
  });

  it('does not duplicate the platform rows', async () => {
    // The left column is an ordinary scroller; duplicating it would show every
    // platform twice for no benefit, and the platform buttons are a filter control
    // rather than a feed to page through.
    await mountFeed();
    const left = scroller('平台列表');
    const names = [...left.querySelectorAll('button')].map((b) => b.textContent || '');
    const bilibili = names.filter((t) => t.includes('哔哩哔哩')).length;

    expect(bilibili).toBe(1);
  });

  it('offers the drag grip on the creator list only', async () => {
    // The left column's height was never adjustable and should stay that way.
    await mountFeed();
    const grips = host!.querySelectorAll('[role="separator"]');

    expect(grips.length).toBe(1);
    expect(grips[0].closest('aside')!.textContent).toContain('创作者');
  });

  it('exposes the 4–8 row range on that grip', async () => {
    await mountFeed();
    const grip = host!.querySelector('[role="separator"]') as HTMLElement;

    expect(grip.getAttribute('aria-valuemin')).toBe('4');
    expect(grip.getAttribute('aria-valuemax')).toBe('8');
  });
});
