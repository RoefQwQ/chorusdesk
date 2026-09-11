// @vitest-environment jsdom
// The dashboard shell opens the Dexie database during setup. Without a real
// `indexedDB`, Dexie rejects asynchronously and vitest reports unhandled errors even
// though the assertions pass — which would make this file noise.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import DashboardApp from '../entrypoints/dashboard/App.vue';

/**
 * The floating reading toolbar (回到顶部 / 标记位置 / 回到标记) belongs to the feed.
 *
 * Reported 2026-09-11, twice. First it was mounted **unconditionally**, so it also
 * floated over 关注管理 and 设置 — a lone bookmark button with no context. It was
 * then narrowed to 动态 + 收藏 on the reasoning that 收藏 is also a scrolling list of
 * post cards, and the user corrected it: 「动态内才有的位置记录标签」 — the feed, and
 * only the feed.
 *
 * Asserted through the toolbar's accessible name (`页面快捷导航`) rather than a class,
 * because that is the part a user or a screen reader actually observes.
 *
 * Mounting the real `App.vue` here is deliberate: it is the component that owns the
 * `v-if`, so a test against an extracted helper would not notice the condition being
 * reverted. The stub surface turned out to be small — `localStorage` plus a `chrome`
 * object — which is why this is affordable at all.
 */

/** The dashboard reads its tab and layout preferences from `localStorage`. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  };
}

/** The minimum `chrome` surface the dashboard shell touches at setup. */
function chromeStub() {
  const noop = () => undefined;
  const asyncNull = async () => null;
  return {
    runtime: {
      id: 'test-extension',
      lastError: undefined,
      getURL: (p: string) => `chrome-extension://test-extension/${p}`,
      sendMessage: vi.fn(async () => undefined),
      onMessage: { addListener: noop, removeListener: noop },
    },
    storage: {
      local: { get: vi.fn(async () => ({})), set: vi.fn(async () => undefined) },
      onChanged: { addListener: noop, removeListener: noop },
    },
    alarms: { get: vi.fn(asyncNull), create: noop, clear: vi.fn(asyncNull), onAlarm: { addListener: noop } },
    tabs: { query: vi.fn(async () => []), sendMessage: noop, create: vi.fn(async () => ({})), remove: vi.fn(async () => undefined) },
    permissions: { contains: vi.fn(async () => true), request: vi.fn(async () => true) },
    action: { setBadgeText: noop, setBadgeBackgroundColor: noop },
    scripting: { executeScript: vi.fn(async () => []) },
  };
}

let app: App | null = null;
let host: HTMLElement | null = null;

/** The floating toolbar, identified by its accessible name. */
function toolbar(): Element | null {
  return host!.querySelector('[aria-label="页面快捷导航"]');
}

/** Click the nav tab whose label contains `label`. */
async function openTab(label: string): Promise<void> {
  const tab = [...host!.querySelectorAll('nav button')].find((b) =>
    (b.textContent || '').includes(label),
  ) as HTMLButtonElement | undefined;
  expect(tab, `nav tab ${label}`).toBeDefined();
  tab!.click();
  await nextTick();
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('chrome', chromeStub());
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(DashboardApp as never);
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('dashboard — floating reading toolbar', () => {
  it('is present on the feed', async () => {
    // The feed is the tab it exists for: a long list of post cards.
    await openTab('动态');
    expect(toolbar()).not.toBeNull();
  });

  it('is absent on 收藏', async () => {
    // 收藏 is also a list of cards, which is why it was briefly kept here. The user
    // rejected that: the toolbar is for the feed.
    await openTab('收藏');
    expect(toolbar()).toBeNull();
  });

  it('is absent on 关注管理', async () => {
    // The original report: a bookmark button floating over the creator table.
    await openTab('关注');
    expect(toolbar()).toBeNull();
  });

  it('is absent on 设置', async () => {
    await openTab('设置');
    expect(toolbar()).toBeNull();
  });

  it('is left-aligned with the right sidebar, not centred in it', async () => {
    // Asked for 2026-09-11: 「把这个右下角的挪动到和上面的创作者卡片的左侧对齐」. Before,
    // the reserved column centred the widget, which put it 115px right of the card's
    // left edge (measured at 1568px: column 272px, widget 42px, (272-42)/2 = 115).
    //
    // The alignment is pure layout, so jsdom cannot measure it. What it CAN hold is the
    // one fact the layout depends on: the reserved column and the right sidebar declare
    // the same widths at the breakpoints where they sit side by side. They are declared
    // in two different files, so changing one silently drifts the widget in the browser
    // and nowhere else. Verified in a real browser at 1568px: both edges at x=1225,
    // delta 0.
    await openTab('动态');
    const reserved = toolbar()!.parentElement as HTMLElement;
    expect(reserved).not.toBeNull();

    const sidebar = [...host!.querySelectorAll('aside')].find((a) =>
      a.className.includes('lg:sticky') && a.className.includes('lg:w-64'),
    ) as HTMLElement;
    expect(sidebar, 'the right sidebar').toBeDefined();

    // Only the breakpoint-prefixed widths: below `lg` the two columns are not side by
    // side (the sidebar goes full width and the widget right-aligns), so the unprefixed
    // widths are deliberately different.
    const breakpointWidths = (el: HTMLElement) =>
      [...el.classList].filter((c) => /^(lg|xl):w-/.test(c)).sort();

    expect(breakpointWidths(reserved)).toEqual(breakpointWidths(sidebar));
    // And the widget is pinned to that column's leading edge.
    expect(reserved.className).toContain('lg:justify-start');
  });

  it('comes back when the feed is reopened', async () => {
    // Guards against the condition being evaluated once instead of reactively.
    await openTab('设置');
    expect(toolbar()).toBeNull();
    await openTab('动态');
    expect(toolbar()).not.toBeNull();
  });
});
