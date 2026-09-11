// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import FeedView from '../entrypoints/dashboard/views/FeedView.vue';

/**
 * The feed's two sidebars, which want different scrollers (2026-09-11, revised 2026-09-12):
 *
 * - the **right** creator list wraps around seamlessly and its height is draggable
 *   between 4 and 8 rows;
 * - the **left** platform list only has to scroll — the user's words: 「左侧的不需要
 *   无头滚动，只需要能上下滚动即可」. It got the same drag grip on 2026-09-12
 *   (「这边也一样做一个跟创作者下方可拉动一样的按钮」): both heights are adjustable, and
 *   each remembers its own.
 *
 * Asserted against the real `FeedView`, because that is where the two are wired and
 * where they could be swapped or mis-nested. `LoopScroll`'s own behaviour is covered
 * in `loopScroll.test.ts`; this only pins which configuration each column got.
 *
 * The distinguishing observations are the ones with real consequences: whether the
 * rows are rendered twice (that duplication *is* the wrap mechanism), and whether a
 * drag grip exists — and, now that both have one, that their stored row counts cannot
 * be each other's.
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

  it('gives both sidebars a drag grip', async () => {
    // Reported 2026-09-12: 「这边也一样做一个跟创作者下方可拉动一样的按钮」. The left
    // column's height is adjustable on exactly the same terms as the right one.
    await mountFeed();
    const grips = [...host!.querySelectorAll('[role="separator"]')];

    // Located by which scroller they resize, not by the enclosing aside's text: both
    // asides mention 「平台」 (every creator row says "N 个平台"), so a text match on the
    // aside cannot tell them apart.
    const resizes = (label: string) =>
      grips.filter((g) => (g.parentElement?.querySelector(`[role="group"][aria-label="${label}"]`) ? true : false));

    expect(grips.length).toBe(2);
    expect(resizes('创作者列表').length).toBe(1);
    expect(resizes('平台列表').length).toBe(1);
  });

  it('keeps the two sidebars row counts independent across a remount', async () => {
    // A shared storage key would make one column's drag silently resize the other.
    // The collision is only observable after a remount: within one mount each
    // `LoopScroll` holds its own ref, and storage is read once at setup. A remount is
    // also exactly when the user would see it, which is what makes it the honest
    // place to assert.
    await mountFeed();
    const gripFor = (label: string) =>
      [...host!.querySelectorAll('[role="separator"]')].find((g) =>
        g.parentElement?.querySelector(`[role="group"][aria-label="${label}"]`),
      )!;

    // Drive the LEFT column to its minimum; the right column is never touched.
    const leftGrip = gripFor('平台列表');
    for (let i = 0; i < 4; i++) {
      leftGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await nextTick();
    }
    expect(leftGrip.getAttribute('aria-valuenow')).toBe('4');

    // Remount against the same stub storage, as a page reload would.
    app?.unmount();
    host?.remove();
    await mountFeed();

    expect(gripFor('平台列表').getAttribute('aria-valuenow')).toBe('4');
    // Untouched column must still be at its default. Under a shared key it comes back
    // at 4, dragged along by the other column's drag.
    expect(gripFor('创作者列表').getAttribute('aria-valuenow')).toBe('6');
  });

  it('exposes the 4–8 row range on both grips', async () => {
    await mountFeed();
    const grips = [...host!.querySelectorAll('[role="separator"]')] as HTMLElement[];

    for (const grip of grips) {
      expect(grip.getAttribute('aria-valuemin')).toBe('4');
      expect(grip.getAttribute('aria-valuemax')).toBe('8');
    }
  });
});
