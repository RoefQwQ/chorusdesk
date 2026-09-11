// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, createSSRApp, h, nextTick } from 'vue';
import { renderToString } from 'vue/server-renderer';
import CreatorsView from '../entrypoints/dashboard/views/CreatorsView.vue';
import type { Channel, Creator } from '../src/types';

/**
 * The compact list's table shape.
 *
 * Three reports about this column, and the first two fixes failed for the same
 * reason: the 「查看全部」 toggle lived *inside* the platform-badge cell, so its
 * horizontal position depended on how many platforms each creator has — a
 * four-platform row pushed it right, a one-platform row left it against the
 * badges, and the column edge came out ragged. Changing the alignment within that
 * cell cannot fix a position that varies with the preceding content; only giving
 * the toggle its own cell can.
 *
 * So these tests pin the two structural facts that make the column line up, and
 * that a browser is not needed to check:
 *
 *  - every row has exactly as many cells as the table has headers (a table whose
 *    counts disagree renders its columns crooked regardless of styling);
 *  - the toggle's cell contains the toggle and nothing else, so its position is
 *    independent of the badges.
 */

const VIEW_MODE_KEY = 'creator_feed_creators_view_mode';

function creator(id: string, name: string): Creator {
  return {
    id,
    name,
    avatar: '',
    tags: ['清水'],
    createdAt: 1,
    updatedAt: 1,
  };
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

/** Three creators with 1, 2 and 4 platforms — the widths that made it ragged. */
const creators = [creator('c1', '一位'), creator('c2', '二位'), creator('c3', '三位')];
const channels = [
  channel('a1', 'c1', 'bilibili'),
  channel('b1', 'c2', 'bilibili'),
  channel('b2', 'c2', 'twitter'),
  channel('d1', 'c3', 'bilibili'),
  channel('d2', 'c3', 'twitter'),
  channel('d3', 'c3', 'youtube'),
  channel('d4', 'c3', 'weibo'),
];

const context = {
  creators,
  channels,
  creatorPostCountMap: { c1: 1, c2: 2, c3: 3 },
  creatorCountByPlatform: { bilibili: 3, twitter: 2, youtube: 1, weibo: 1 },
  platformOrder: ['bilibili', 'twitter', 'youtube', 'weibo'],
};

async function renderList(): Promise<string> {
  const app = createSSRApp({
    render: () => h(CreatorsView as never, { context }),
  });
  return renderToString(app);
}

/** Cells of the first data row of the compact-list table. */
function firstRowCells(html: string): string[] {
  const tbody = html.slice(html.indexOf('<tbody'));
  const firstRow = tbody.slice(tbody.indexOf('<tr'), tbody.indexOf('</tr>'));
  return [...firstRow.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
}

/**
 * Minimal in-memory Storage.
 *
 * The component reads its view mode from `localStorage` at setup time, and the
 * jsdom environment's own implementation is not usable here. Supplying one also
 * makes the test independent of the environment's storage configuration.
 */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  };
}

beforeEach(() => {
  // The view mode is persisted, so the component's default is whatever the user
  // last chose. Seeded here to reach the compact list deterministically.
  const storage = memoryStorage();
  storage.setItem(VIEW_MODE_KEY, 'list');
  vi.stubGlobal('localStorage', storage);
});

describe('creators compact list — table shape', () => {
  it('renders one cell per header', async () => {
    const html = await renderList();
    const thead = html.slice(html.indexOf('<thead'), html.indexOf('</thead>'));
    const headers = [...thead.matchAll(/<th\b[^>]*>/g)];

    expect(headers.length).toBeGreaterThan(0);
    expect(firstRowCells(html)).toHaveLength(headers.length);
  });

  it('spans the full table width when a creator is expanded', async () => {
    // Must mount and actually expand a row. Reading the colspan from a plain
    // render finds nothing: the detail row sits behind `v-if`, so an SSR pass
    // renders no colspan at all and the assertion passes vacuously — which it
    // did, until a mutation that broke the colspan left it green.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp({ render: () => h(CreatorsView as never, { context }) });
    app.mount(host);
    try {
      const headerCount = host.querySelectorAll('thead th').length;
      expect(headerCount).toBeGreaterThan(0);

      const toggle = [...host.querySelectorAll('button')].find((b) =>
        (b.textContent || '').includes('查看全部'),
      );
      expect(toggle).toBeDefined();
      toggle!.click();
      await nextTick();

      const spanned = host.querySelector('td[colspan]');
      expect(spanned).not.toBeNull();
      // One cell short leaves a visible gap at the right edge of the table.
      expect(Number(spanned!.getAttribute('colspan'))).toBe(headerCount);
    } finally {
      app.unmount();
      host.remove();
    }
  });

  it('keeps the expander alone in its cell', async () => {
    // The whole fix: the toggle's position must not depend on the badges before
    // it. If it shares a cell with them, its x moves with the platform count.
    //
    // Asserted as "this cell contains exactly one element", not as "no platform
    // names appear in it": nested components do not resolve in this environment
    // (`Failed to resolve component: PlatformBadge`), so the badges render as an
    // empty tag and a text-based check would pass no matter where the toggle sat.
    const cells = firstRowCells(await renderList());
    const toggleCell = cells.find((c) => c.includes('查看全部'));

    expect(toggleCell).toBeDefined();
    // Nothing before the button, nothing after it.
    expect(toggleCell!.trim()).toMatch(/^<button\b[\s\S]*<\/button>$/);
  });

  it('still renders the platform badges for every creator', async () => {
    // The badges did not move out of the table — only into their own cell.
    const html = await renderList();

    expect(html).toContain('已绑平台账号');
    // One toggle per creator.
    expect((html.match(/查看全部/g) ?? [])).toHaveLength(creators.length);
  });
});
