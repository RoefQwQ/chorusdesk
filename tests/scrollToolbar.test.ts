// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import ScrollActionToolbar from '../entrypoints/dashboard/components/ScrollActionToolbar.vue';

/**
 * The floating reading controls: which ones appear, in what order, and whether their
 * names are reachable.
 *
 * Redesigned 2026-09-11 after 「最下方的这个回顶按钮看起来需要重新设计外观」. The
 * screenshot showed two icon-only squares in no container: unrecognisable glyphs, no
 * labels, and nothing telling the user what any of them did. Behaviour did not change,
 * so what is pinned here is exactly what was wrong:
 *
 * 1. the order is fixed so the bottom-most control is always 回到顶部;
 * 2. every control has an accessible name, and that name becomes *visible* on hover and
 *    on focus — not merely a `title` that a touch user and a screenshot never see;
 * 3. a control's absence cannot shuffle the meaning of the others.
 */

const SCROLL_MARK_KEY = 'cfh_marked_scroll_y';

/** `window.scrollY` is read-only in jsdom; the toolbar reads it on every scroll. */
function setScrollY(value: number) {
  Object.defineProperty(window, 'scrollY', { value, configurable: true, writable: true });
  Object.defineProperty(document.documentElement, 'scrollTop', { value, configurable: true, writable: true });
}

let app: App | null = null;
let host: HTMLElement | null = null;

function mount(): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(ScrollActionToolbar as never);
  app.mount(host);
  return host;
}

/** Re-read the scroll position, as the real `scroll` event would. */
async function scrollTo(y: number) {
  setScrollY(y);
  window.dispatchEvent(new Event('scroll'));
  await nextTick();
}

function buttons(): HTMLButtonElement[] {
  return [...host!.querySelectorAll('button')] as HTMLButtonElement[];
}

/** Names shown in the label element (as opposed to the permanent accessible name). */
function visibleLabels(): string[] {
  return [...host!.querySelectorAll('aside button span')]
    .filter((s) => s.getAttribute('aria-hidden') !== 'true' && !s.classList.contains('rounded-full'))
    .map((s) => (s.textContent || '').trim())
    .filter(Boolean);
}

beforeEach(() => {
  const map = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: () => null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage);
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true, writable: true });
  Object.defineProperty(window, 'scrollTo', { value: vi.fn(), configurable: true, writable: true });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('reading toolbar — which controls appear', () => {
  it('offers only the marker at the top of the page', async () => {
    // Nothing to go back to and nothing marked yet.
    mount();
    await scrollTo(0);

    const names = buttons().map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['标记当前浏览位置']);
  });

  it('adds the back-to-top control once the page is scrolled', async () => {
    mount();
    await scrollTo(600);

    expect(buttons().map((b) => b.getAttribute('aria-label'))).toEqual([
      '标记当前浏览位置',
      '回到顶部',
    ]);
  });

  it('puts 回到顶部 last, which is the control that was pointed at', async () => {
    // 「最下方的这个回顶按钮」 — the bottom-most one is the back-to-top, and stays so.
    mount();
    await scrollTo(600);
    buttons()[0].click();
    await nextTick();

    const names = buttons().map((b) => b.getAttribute('aria-label'));
    expect(names.at(-1)).toBe('回到顶部');
  });

  it('adds jump-to-mark only once a mark exists and the user has moved away', async () => {
    mount();
    await scrollTo(800);
    // Marking from here, then staying put: nothing to jump back to.
    buttons().find((b) => b.getAttribute('aria-label') === '标记当前浏览位置')!.click();
    await nextTick();
    expect(buttons().map((b) => b.getAttribute('aria-label'))).not.toContain('回到标记位置');

    // Move far away ⇒ the jump becomes meaningful.
    await scrollTo(2000);
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toContain('回到标记位置');
    // And it is the first control, ahead of the marker.
    expect(buttons()[0].getAttribute('aria-label')).toBe('回到标记位置');
  });

  it('marks the state on the control instead of recolouring it', async () => {
    // The old design made this control a filled amber block, which read as the primary
    // action when it is a secondary one. State is now a small indicator.
    mount();
    await scrollTo(800);
    const marker = () => buttons().find((b) => b.getAttribute('aria-label')?.includes('标记'))!;

    expect(marker().querySelector('span.rounded-full')).toBeNull();
    marker().click();
    await nextTick();

    const dot = marker().querySelector('span.rounded-full');
    expect(dot).not.toBeNull();
    expect(dot!.getAttribute('aria-hidden')).toBe('true');
    // The label changes to reflect the new action.
    expect(marker().getAttribute('aria-label')).toBe('重新标记当前位置');
  });
});

describe('reading toolbar — names are visible, not just announced', () => {
  it('shows each control name on hover and hides it again', async () => {
    // `title` alone is invisible to touch users and to any screenshot; the complaint
    // was that the icons conveyed nothing.
    mount();
    await scrollTo(600);

    expect(visibleLabels()).toEqual([]);

    const top = buttons().at(-1)!;
    top.dispatchEvent(new MouseEvent('mouseenter'));
    await nextTick();
    expect(visibleLabels()).toEqual(['回到顶部']);

    top.dispatchEvent(new MouseEvent('mouseleave'));
    await nextTick();
    expect(visibleLabels()).toEqual([]);
  });

  it('shows the name on keyboard focus too', async () => {
    mount();
    await scrollTo(600);

    const top = buttons().at(-1)!;
    top.dispatchEvent(new FocusEvent('focus'));
    await nextTick();
    expect(visibleLabels()).toEqual(['回到顶部']);

    top.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(visibleLabels()).toEqual([]);
  });

  it('gives every control an accessible name at all times', async () => {
    mount();
    await scrollTo(600);

    for (const b of buttons()) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
    }
  });
});

describe('reading toolbar — the marker', () => {
  it('persists the marked position across mounts', async () => {
    mount();
    await scrollTo(900);
    buttons().find((b) => b.getAttribute('aria-label')?.includes('标记'))!.click();
    await nextTick();
    expect(sessionStorage.getItem(SCROLL_MARK_KEY)).toBe('900');

    app!.unmount();
    host!.remove();
    mount();
    await scrollTo(2000);

    // Its presence is the observable effect of the restored mark.
    expect(buttons().map((b) => b.getAttribute('aria-label'))).toContain('回到标记位置');
  });
});
