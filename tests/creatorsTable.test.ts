// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import CreatorsView from '../entrypoints/dashboard/views/CreatorsView.vue';
import type { Channel, Creator } from '../src/types';

/**
 * The compact list: table shape and sorting.
 *
 * Reported three times. The first two fixes moved the expander's alignment around
 * *inside* the platform-badge cell, which cannot work: its x varied with how many
 * badges the row had. Measured on a replica with the real stylesheet, rows of one,
 * two and four badges put it at 482 / 512 / 575 px — 93px of ragged edge. The
 * researched pattern for a row disclosure control is a leading chevron, so that is
 * where it went, and the invented 「明细」 column went away with it.
 *
 * The headers are now sortable, following the W3C sortable-table pattern: the
 * label is wrapped in a `<button>` that fills the cell, and `aria-sort` reports the
 * direction on the sorted column only.
 */

const VIEW_MODE_KEY = 'creator_feed_creators_view_mode';

/** Minimal in-memory Storage: the view mode is read from it at setup time. */
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

function creator(id: string, name: string, tags: string[], updatedAt: number): Creator {
  return { id, name, avatar: '', tags, createdAt: 1, updatedAt };
}

function channel(id: string, creatorId: string, platform: string): Channel {
  return {
    id,
    creatorId,
    platform,
    accountId: id,
    displayName: id,
    status: 'idle',
    profileUrl: 'https://example.com/' + id,
  };
}

// Deliberately crossed: name order, post-count order, channel-count order and
// recency order are all different, so a wrong sort key cannot pass by accident.
const creators = [
  creator('c1', '丙丙', ['绘画'], 300),
  creator('c2', '啊啊', ['ASMR'], 100),
  creator('c3', '不不', ['清水'], 200),
];
const channels = [
  channel('c1a', 'c1', 'bilibili'),
  channel('c2a', 'c2', 'bilibili'),
  channel('c2b', 'c2', 'twitter'),
  channel('c2c', 'c2', 'youtube'),
  channel('c3a', 'c3', 'bilibili'),
  channel('c3b', 'c3', 'twitter'),
];
const postCounts = { c1: 50, c2: 10, c3: 30 };

const context = {
  creators,
  channels,
  creatorPostCountMap: postCounts,
  creatorCountByPlatform: { bilibili: 3, twitter: 2, youtube: 1 },
  platformOrder: ['bilibili', 'twitter', 'youtube'],
};

let app: App | null = null;
let host: HTMLElement | null = null;

async function mount(): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(CreatorsView as never, { context } as never);
  app.mount(host);
  await nextTick();
  return host;
}

/** Creator names in render order. */
function renderedNames(): string[] {
  return [...host!.querySelectorAll('tbody > tr')]
    .filter((tr) => !tr.querySelector('td[colspan]'))
    .map((tr) => {
      const cell = tr.querySelector('td:first-child');
      const text = cell?.textContent || '';
      return creators.map((c) => c.name).find((n) => text.includes(n)) ?? '';
    })
    .filter(Boolean);
}

function headerButton(label: string): HTMLButtonElement | undefined {
  return [...host!.querySelectorAll('thead th button')].find((b) =>
    (b.textContent || '').includes(label) && !(b.textContent || '').includes('全选'),
  ) as HTMLButtonElement | undefined;
}

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
});

beforeEach(() => {
  const storage = memoryStorage();
  storage.setItem(VIEW_MODE_KEY, 'list');
  vi.stubGlobal('localStorage', storage);
  // Force a single column. The grid and detailed views distribute creators into
  // masonry columns (`cols[idx % count]`), so with two or more columns the DOM
  // order is column-major and no longer equals the sort order — the first version
  // of the view-crossing test below failed for exactly that reason, not because
  // the sort was wrong.
  Object.defineProperty(window, 'innerWidth', { value: 600, configurable: true });
});

describe('creators compact list — table shape', () => {
  it('renders one cell per header', async () => {
    const root = await mount();
    const headers = root.querySelectorAll('thead th');
    const cells = root.querySelectorAll('tbody tr:first-child td');

    expect(headers.length).toBeGreaterThan(0);
    expect(cells.length).toBe(headers.length);
  });

  it('spans the full table width when a creator is expanded', async () => {
    // Must actually expand: the detail row is behind `v-if`, so a collapsed
    // render has no colspan to check and the assertion would pass vacuously.
    const root = await mount();
    const headerCount = root.querySelectorAll('thead th').length;

    const disclosure = root.querySelector('tbody tr td button[aria-expanded]') as HTMLButtonElement;
    expect(disclosure).not.toBeNull();
    disclosure.click();
    await nextTick();

    const spanned = root.querySelector('td[colspan]');
    expect(spanned).not.toBeNull();
    expect(Number(spanned!.getAttribute('colspan'))).toBe(headerCount);
  });

  it('leads the creator cell with the disclosure control', async () => {
    // The researched placement, and the reason the ragged edge is gone: first
    // thing in the cell, so its x does not depend on the platform badges later in
    // the row.
    const root = await mount();
    const creatorCell = root.querySelector('tbody tr:first-child td:first-child') as HTMLElement;
    const disclosure = creatorCell.querySelector('button[aria-expanded]') as HTMLElement;
    const avatar = creatorCell.querySelector('img, .rounded-lg') as HTMLElement;
    const name = creatorCell.querySelector('span') as HTMLElement;

    expect(disclosure).not.toBeNull();
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    // It comes before everything else in the cell, in DOM order.
    const precedes = (a: Node, b: Node) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(disclosure, avatar)).toBe(true);
    expect(precedes(disclosure, name)).toBe(true);
  });

  it('reports the expanded state on the disclosure control', async () => {
    const root = await mount();
    const disclosure = root.querySelector('tbody tr td button[aria-expanded]') as HTMLButtonElement;

    disclosure.click();
    await nextTick();

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('creators compact list — sortable headers', () => {
  it('marks the sortable columns and leaves the action column alone', async () => {
    const root = await mount();
    const headers = [...root.querySelectorAll('thead th')];

    // Every header except the last (操作) offers a sort button.
    expect(headers.slice(0, -1).every((th) => th.querySelector('button'))).toBe(true);
    expect(headers.at(-1)!.querySelector('button')).toBeNull();
    // …and the action column carries no sort state at all.
    expect(headers.at(-1)!.hasAttribute('aria-sort')).toBe(false);
  });

  it('exposes the sort direction through aria-sort', async () => {
    await mount();

    // Default order is by recency, descending.
    expect(headerButton('同步状态')!.closest('th')!.getAttribute('aria-sort')).toBe('descending');
    expect(headerButton('创作者')!.closest('th')!.getAttribute('aria-sort')).toBe('none');
  });

  it('sorts by the clicked column', async () => {
    await mount();
    // Recency order is 丙(300), 不(200), 啊(100).
    expect(renderedNames()).toEqual(['丙丙', '不不', '啊啊']);

    headerButton('作品数')!.click();
    await nextTick();
    // Post counts are 丙50, 不30, 啊10 → descending by default.
    expect(renderedNames()).toEqual(['丙丙', '不不', '啊啊']);

    headerButton('已绑平台账号')!.click();
    await nextTick();
    // Channel counts: 啊3, 不2, 丙1 → descending.
    expect(renderedNames()).toEqual(['啊啊', '不不', '丙丙']);
  });

  it('flips direction when the same header is clicked again', async () => {
    await mount();

    headerButton('已绑平台账号')!.click();
    await nextTick();
    expect(renderedNames()).toEqual(['啊啊', '不不', '丙丙']);

    headerButton('已绑平台账号')!.click();
    await nextTick();
    expect(renderedNames()).toEqual(['丙丙', '不不', '啊啊']);
    expect(headerButton('已绑平台账号')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('defaults text columns to A→Z and numeric ones to largest-first', async () => {
    await mount();

    headerButton('创作者')!.click();
    await nextTick();
    // Names 啊/不/丙 are in that order in code-point terms; ascending is the
    // natural default for text.
    expect(renderedNames()[0]).toBe('啊啊');
    expect(headerButton('创作者')!.closest('th')!.getAttribute('aria-sort')).toBe('ascending');

    headerButton('作品数')!.click();
    await nextTick();
    expect(renderedNames()[0]).toBe('丙丙');
    expect(headerButton('作品数')!.closest('th')!.getAttribute('aria-sort')).toBe('descending');
  });

  it('keeps ties in a stable order rather than shuffling', async () => {
    // Equal post counts must not reorder between renders.
    const tied = {
      ...context,
      creatorPostCountMap: { c1: 5, c2: 5, c3: 5 },
    };
    host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp(CreatorsView as never, { context: tied } as never);
    app.mount(host);
    await nextTick();

    headerButton('作品数')!.click();
    await nextTick();
    const first = renderedNames();
    headerButton('作品数')!.click();
    await nextTick();
    headerButton('作品数')!.click();
    await nextTick();

    expect(renderedNames()).toEqual(first);
  });
});

describe('creators directory — sorting applies to every view', () => {
  /**
   * Sort order by the position each name first appears in the rendered text.
   *
   * Works for all three layouts without depending on their internal markup, which
   * matters because the grid and detailed views have no table for a helper to
   * target.
   */
  function orderInDocument(root: HTMLElement): string[] {
    const text = root.textContent || '';
    return creators
      .map((c) => ({ name: c.name, at: text.indexOf(c.name) }))
      .filter((x) => x.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((x) => x.name);
  }

  async function switchTo(label: string): Promise<void> {
    const btn = [...host!.querySelectorAll('button')].find((b) =>
      (b.getAttribute('title') || '').includes(label),
    ) as HTMLButtonElement;
    expect(btn).toBeDefined();
    btn.click();
    await nextTick();
  }

  it('carries the header sort into the grid view', async () => {
    // The complaint was that only the list could be sorted. The order lives in one
    // shared state, so a header click has to survive the switch to another layout.
    await mount();
    headerButton('作品数')!.click();
    await nextTick();
    expect(renderedNames()).toEqual(['丙丙', '不不', '啊啊']);

    await switchTo('网格磁贴视图');
    // Same order, different layout.
    expect(orderInDocument(host!)).toEqual(['丙丙', '不不', '啊啊']);
  });

  it('carries the header sort into the detailed view', async () => {
    await mount();
    headerButton('已绑平台账号')!.click();
    await nextTick();
    expect(renderedNames()).toEqual(['啊啊', '不不', '丙丙']);

    await switchTo('详细卡片视图');
    expect(orderInDocument(host!)).toEqual(['啊啊', '不不', '丙丙']);
  });

  it('offers the sort control in every view', async () => {
    // Grid and detailed have no columns to click, so the dropdown is the only
    // handle there — it must not be inside the list branch.
    await mount();
    expect(host!.textContent).toContain('排序');

    for (const [label, mode] of [['网格磁贴视图', 'grid'], ['详细卡片视图', 'detailed'], ['紧凑列表视图', 'list']] as const) {
      await switchTo(label);
      expect(host!.textContent).toContain('排序');
      expect(localStorage.getItem(VIEW_MODE_KEY)).toBe(mode);
    }
  });
});

describe('creators compact list — the platform column', () => {
  it('renders a badge per platform instead of an empty cell', async () => {
    // Reported 2026-09-11: the 已绑平台账号 column was blank on every row, in all
    // three views. `PlatformBadge` was used in the template but its import had been
    // deleted, so the tag resolved to nothing and Vue rendered an empty placeholder
    // without a word. `vue-tsc` cannot see that unless
    // `vueCompilerOptions.strictTemplates` is on — it is now, and this test pins the
    // rendering so the check is not the only guard.
    const root = await mount();
    const badges = [...root.querySelectorAll('tbody tr:first-child td:nth-child(2) span')].filter(
      (el) => (el.textContent || '').trim().length > 0,
    );

    expect(badges.length).toBeGreaterThan(0);
    // The label, not the raw platform key: 哔哩哔哩 (c1/c2/c3 all have bilibili).
    expect(badges.map((b) => b.textContent?.trim()).join(' ')).toContain('哔哩哔哩');
  });

  it('renders the delete control in the action cell', async () => {
    // `Trash2` was missing from the same import block, so the button rendered as an
    // empty square — visible only as a gap between the remaining icons.
    const root = await mount();
    const remove = root.querySelector('tbody tr:first-child button[title="移除创作者"]');

    expect(remove).not.toBeNull();
    expect(remove!.querySelector('svg')).not.toBeNull();
  });

  it('puts 已绑平台账号 before 标签', async () => {
    // Swapped on request: the platforms identify the creator across sites and read
    // better against the name than the free-form tags do.
    const root = await mount();
    const labels = [...root.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());

    expect(labels.indexOf('已绑平台账号')).toBeGreaterThan(-1);
    expect(labels.indexOf('已绑平台账号')).toBeLessThan(labels.indexOf('标签'));
  });
});

describe('creators compact list — row click', () => {
  /** True when a detail row is rendered. */
  function expanded(): boolean {
    return host!.querySelector('td[colspan]') !== null;
  }

  it('toggles the detail row when the row itself is clicked', async () => {
    await mount();
    const row = host!.querySelector('tbody tr') as HTMLElement;

    expect(expanded()).toBe(false);
    row.click();
    await nextTick();
    expect(expanded()).toBe(true);
    row.click();
    await nextTick();
    expect(expanded()).toBe(false);
  });

  it('toggles once when the chevron is clicked, not twice', async () => {
    // The chevron is inside the row, so a bubbled click would toggle it a second
    // time and cancel out. This caught exactly that.
    await mount();
    const chevron = host!.querySelector('tbody tr td button[aria-expanded]') as HTMLButtonElement;

    chevron.click();
    await nextTick();
    expect(expanded()).toBe(true);
    expect(chevron.getAttribute('aria-expanded')).toBe('true');
  });

  it('leaves the row alone when a row control is used', async () => {
    // Every control in the row stops propagation, so it does its own job without
    // also opening the row underneath.
    await mount();

    const controls = [
      'tbody tr:first-child button[title="同步最新动态"]',
      'tbody tr:first-child button[title="回溯历史作品"]',
      'tbody tr:first-child button[title="绑定新账号"]',
      'tbody tr:first-child button[title="编辑标签"]',
      // The avatar is a div, not a button.
      'tbody tr:first-child [title="更换主头像"]',
    ];
    for (const selector of controls) {
      const el = host!.querySelector(selector) as HTMLElement | null;
      expect(el, selector).not.toBeNull();
      el!.click();
      await nextTick();
      expect(expanded(), selector).toBe(false);
    }
  });

  it('leaves the row alone when a tag chip is used', async () => {
    // A tag chip filters the list; it must not also expand the row it sits in.
    await mount();
    const chip = host!.querySelector('tbody tr:first-child td:nth-child(3) span') as HTMLElement;

    expect(chip).not.toBeNull();
    chip.click();
    await nextTick();
    expect(expanded()).toBe(false);
  });

  it('leaves the row alone when the click finishes a text selection', async () => {
    // Dragging across a creator's name to copy it ends with a click on the last
    // word; without the guard that would collapse or expand the row under the
    // cursor.
    await mount();
    const selection = { isCollapsed: false } as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);

    (host!.querySelector('tbody tr') as HTMLElement).click();
    await nextTick();

    expect(expanded()).toBe(false);
  });
});
