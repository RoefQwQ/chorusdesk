// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import CreatorsView, { type CreatorsViewContext } from '../entrypoints/dashboard/views/CreatorsView.vue';
import type { Channel, Creator } from '../src/types';

/**
 * The directory's empty state offers one button, 清除筛选, and it must clear every
 * filter the list reads.
 *
 * It did not. The button reset search, platform and tags by hand — in the template —
 * but not the account-type filter, so on a list emptied by account type alone the
 * click changed nothing on screen: the filter that caused the empty state was still
 * set. A user hitting it saw a dead button.
 *
 * This test drives the REAL view and clicks the REAL button, because that is where
 * the bug was. An earlier version of this file tested the composable's
 * `clearAllDirectoryFilters` instead, and a mutation putting the hand-written
 * three-filter expression back into the template left it green — the test could not
 * see the thing that had actually broken (AGENTS rule 26). The wiring from the
 * button to the shared function is the contract; asserting the function alone
 * asserts a different one.
 */

const now = Date.UTC(2026, 8, 11, 12, 0, 0);

/**
 * `localStorage` in this environment is present but unusable without a stub — the
 * view reads its saved layout from it during setup. Same shape as the sibling
 * `dashboardToolbar.test.ts` uses.
 */
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
vi.stubGlobal('localStorage', memoryStorage());

const creator = (id: string, name: string): Creator =>
  ({ id, name, avatar: '', tags: [], note: '', sortOrder: 0, createdAt: now, updatedAt: now }) as Creator;

const channel = (creatorId: string, role: Channel['accountRole']): Channel =>
  ({
    id: `${creatorId}_${role}`,
    creatorId,
    platform: 'bilibili',
    accountId: 'a',
    displayName: 'n',
    label: '',
    accountRole: role,
    profileUrl: 'https://example.com/a',
    status: 'idle',
  }) as Channel;

const context: CreatorsViewContext = {
  creators: [creator('c1', '丙丙'), creator('c2', '啊啊'), creator('c3', '不不')],
  channels: [channel('c1', 'main'), channel('c2', 'main'), channel('c3', 'sub')],
  creatorPostCountMap: { c1: 1, c2: 1, c3: 1 },
  creatorCountByPlatform: { bilibili: 3 },
  platformOrder: ['bilibili'],
};

function mount(): { app: App; el: HTMLElement } {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(CreatorsView, { context });
  app.mount(el);
  return { app, el };
}

/**
 * Buttons whose trimmed text starts with `label`. A prefix rather than equality
 * because the role pills carry their count in the same element (`里号(0)`), and the
 * label is the part that identifies the control.
 */
const buttons = (el: HTMLElement, label: string): HTMLButtonElement[] =>
  [...el.querySelectorAll('button')].filter((b) => (b.textContent || '').trim().startsWith(label)) as HTMLButtonElement[];

const click = async (el: HTMLElement, label: string) => {
  const [b] = buttons(el, label);
  if (!b) throw new Error(`no button labelled ${label}`);
  b.click();
  await nextTick();
  await nextTick();
};

/**
 * The directory's own count badge ("N / M 位创作者") — the same reading the browser
 * harness in `e2e/creators-render.mjs` asserts on. Preferred over counting name
 * elements: the badge is stable across the three view modes and is itself
 * user-visible, whereas the name markup differs per mode.
 */
const visible = (el: HTMLElement): number => {
  const m = el.textContent?.match(/(\d+) \/ \d+ 位创作者/);
  if (!m) throw new Error('the creator count badge is not rendered');
  return Number(m[1]);
};

describe('creators directory — the 清除筛选 button', () => {
  it('restores the list when the account-type filter alone emptied it', async () => {
    const { app, el } = mount();
    try {
      expect(visible(el)).toBe(3);

      // '里号/差分' matches nobody in this fixture, so the filter it sets is the ONLY
      // reason the list is empty. That is the configuration the button used to miss.
      await click(el, '里号');
      expect(visible(el)).toBe(0);
      expect(buttons(el, '清除筛选')).toHaveLength(1);

      await click(el, '清除筛选');

      expect(visible(el)).toBe(3);
    } finally {
      app.unmount();
      el.remove();
    }
  });

  it('also clears the search box, and shows it as cleared', async () => {
    const { app, el } = mount();
    try {
      const input = el.querySelector('input[placeholder^="快速搜索创作者"]') as HTMLInputElement;
      expect(input).toBeTruthy();
      input.value = '不存在的名字';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await nextTick();
      await nextTick();

      expect(visible(el)).toBe(0);
      await click(el, '清除筛选');

      expect(visible(el)).toBe(3);
      // The box must show no filter either: a stale query would leave the user
      // reading a filter that is no longer applied.
      expect(input.value).toBe('');
    } finally {
      app.unmount();
      el.remove();
    }
  });
});
