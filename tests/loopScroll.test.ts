// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick, type App } from 'vue';
import LoopScroll from '../entrypoints/dashboard/components/LoopScroll.vue';

/**
 * LoopScroll: the seamless wrap and the row clamp.
 *
 * jsdom does not do layout, so the *measurement* cannot be exercised here — that is
 * verified in a real browser. What is testable, and what actually breaks, is the
 * arithmetic: the wrap must move `scrollTop` by exactly one copy's height, the copy
 * count must be right for the available height, and the row count must stay inside
 * 4–8 whatever the stored value or the drag says.
 *
 * Height is therefore driven through the `itemCount`/rows path with the geometry
 * stubbed onto the element, rather than pretended from a fake layout engine.
 */

const ITEM_H = 48;
const GAP = 8;

/**
 * Controllable ResizeObserver.
 *
 * The component re-measures when its content resizes; jsdom has no ResizeObserver at
 * all, so without this the re-measure path would be dead here and the geometry stub
 * applied after mount would never be picked up.
 */
const observers: Array<() => void> = [];
class FakeResizeObserver {
  constructor(private cb: () => void) {
    observers.push(() => this.cb());
  }
  observe() {}
  disconnect() {}
  unobserve() {}
}

/** Re-run the component's measurement, as a real resize would. */
async function remeasure() {
  observers.slice().forEach((fire) => fire());
  await flush();
}

/** Give the viewport and its first copy the geometry a real layout would produce. */
function stubGeometry(el: HTMLElement, items: number, visibleRows: number) {
  const pitch = ITEM_H + GAP;
  const copyH = items * ITEM_H + (items - 1) * GAP;
  const height = visibleRows * ITEM_H + (visibleRows - 1) * GAP;

  const viewport = el.querySelector('[role="group"]') as HTMLElement;
  Object.defineProperty(viewport, 'clientHeight', { value: height, configurable: true });
  Object.defineProperty(viewport, 'offsetHeight', { value: height, configurable: true });

  const copies = [...viewport.children] as HTMLElement[];
  copies.forEach((copy, i) => {
    Object.defineProperty(copy, 'offsetHeight', { value: copyH, configurable: true });
    [...copy.children].forEach((item, j) => {
      Object.defineProperty(item, 'offsetHeight', {
        // Vary the middle item so the "shortest row" rule is exercised.
        value: i === 0 && j === 1 ? ITEM_H + 30 : ITEM_H,
        configurable: true,
      });
    });
  });
  return { viewport, copyH, height, pitch };
}

/** Flush rAF, which `measure` is scheduled behind. */
async function flush() {
  for (let i = 0; i < 3; i += 1) {
    vi.advanceTimersByTime(20);
    await nextTick();
  }
}

let app: App | null = null;
let host: HTMLElement | null = null;

/** The component owns its row count, so the harness only supplies the initial props. */
const Harness = defineComponent({
  props: { items: { type: Number, default: 10 }, storageKey: { type: String, default: undefined } },
  setup(props) {
    return () =>
      h(
        LoopScroll,
        { itemCount: props.items, rows: 6, minRows: 4, maxRows: 8, resizable: true, storageKey: props.storageKey },
        { default: () => Array.from({ length: props.items }, (_, i) => h('div', { 'data-row': i }, `第 ${i} 行`)) },
      );
  },
});

function mountHarness(props: Record<string, unknown> = {}) {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(Harness, { items: 10, ...props });
  app.mount(host);
  return host;
}

function viewport(): HTMLElement {
  return host!.querySelector('[role="group"]') as HTMLElement;
}

function grip(): HTMLElement {
  return host!.querySelector('[role="separator"]') as HTMLElement;
}

beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.useFakeTimers({ shouldAdvanceTime: true });
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('LoopScroll — seamless wrap', () => {
  it('renders two copies when one copy overflows the viewport', async () => {
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp } = stubGeometry(host!, 10, 6);
    await remeasure();

    expect(vp.children.length).toBe(2);
  });

  it('renders one copy when the content already fits', async () => {
    // With nothing to scroll, a second copy would only duplicate content.
    mountHarness({ items: 3 });
    await flush();
    stubGeometry(host!, 3, 6);
    await remeasure();

    expect(viewport().children.length).toBe(1);
  });

  it('wraps by exactly one copy height, landing on identical content', async () => {
    // This is the whole mechanism: the two copies are byte-identical, so moving
    // `scrollTop` back by one copy height must be visually undetectable. If the
    // subtraction used anything else — the item count, the row pitch, the viewport
    // height — the list would visibly jump.
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp, copyH } = stubGeometry(host!, 10, 6);
    await remeasure();

    // Land just past the end of the first copy, as scrolling would.
    vp.scrollTop = copyH + 5;
    vp.dispatchEvent(new Event('scroll'));
    await flush();

    expect(vp.scrollTop).toBe(5);
  });

  it('leaves scrollTop alone while inside the first copy', async () => {
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp } = stubGeometry(host!, 10, 6);
    await remeasure();

    vp.scrollTop = 100;
    vp.dispatchEvent(new Event('scroll'));
    await flush();

    expect(vp.scrollTop).toBe(100);
  });

  it('wraps at the end of the first copy, not at the viewport height', async () => {
    // The threshold is the *copy* height, and this is the only position that tells the
    // two apart: the viewport is shorter than a copy, so a scroll position beyond the
    // viewport but still inside copy 1 must be left alone. Using the viewport height as
    // the threshold looks equivalent — both wrap somewhere "near the end" — but it
    // teleports the user back to the top while copy 1 still has content below the fold.
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp, copyH, height } = stubGeometry(host!, 10, 6);
    await remeasure();

    const between = height + 10;
    expect(between).toBeLessThan(copyH); // the test is meaningless unless this holds

    vp.scrollTop = between;
    vp.dispatchEvent(new Event('scroll'));
    await flush();

    expect(vp.scrollTop).toBe(between);
  });

  it('keeps the top of the list a real stop', async () => {
    // The wrap is one-directional by design: only the end is seamless, so the start
    // of the list is a genuine boundary rather than a teleport.
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp } = stubGeometry(host!, 10, 6);
    await remeasure();

    vp.scrollTop = 0;
    vp.dispatchEvent(new Event('scroll'));
    await flush();

    expect(vp.scrollTop).toBe(0);
  });

  it('hides the duplicate copy from assistive tech', async () => {
    mountHarness({ items: 10 });
    await flush();
    const { viewport: vp } = stubGeometry(host!, 10, 6);
    await remeasure();

    const copies = [...vp.children];
    expect(copies[0].getAttribute('aria-hidden')).toBeNull();
    expect(copies[1].getAttribute('aria-hidden')).toBe('true');
  });

  it('does not loop when loop is disabled', async () => {
    // The left platform column wants an ordinary capped scroller.
    host = document.createElement('div');
    document.body.appendChild(host);
    // `setup` must return a render function, not VNodes — returning VNodes directly
    // leaves the component unrendered and the query below silently finds nothing.
    const Plain = defineComponent({
      setup: () => () =>
        h(LoopScroll, { itemCount: 10, rows: 6, loop: false }, { default: () => Array.from({ length: 10 }, (_, i) => h('div', {}, String(i))) }),
    });
    app = createApp(Plain);
    app.mount(host);
    await flush();
    stubGeometry(host, 10, 6);
    await remeasure();

    expect(viewport().children.length).toBe(1);
    // And a scroll past the top is left as the browser put it — no wrap.
    const vp = viewport();
    vp.scrollTop = 9999;
    vp.dispatchEvent(new Event('scroll'));
    await flush();
    expect(vp.scrollTop).toBe(9999);
  });
});

describe('LoopScroll — row count', () => {
  it('clamps a stored value into 4–8', async () => {
    // A hand-edited or corrupt localStorage value must not produce a broken layout.
    for (const [stored, expected] of [['99', '8'], ['0', '4'], ['not-a-number', '6']] as const) {
      localStorage.setItem('rows-key', stored);
      mountHarness({ storageKey: 'rows-key' });
      await flush();

      expect(grip().getAttribute('aria-valuenow'), `stored ${stored}`).toBe(expected);
      app?.unmount();
      host?.remove();
    }
  });

  it('steps by one per arrow key and stops at the bounds', async () => {
    mountHarness({ items: 10 });
    await flush();
    stubGeometry(host!, 10, 6);
    await remeasure();

    const g = grip();
    expect(g.getAttribute('aria-valuenow')).toBe('6');

    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('7');

    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('5');

    // Past the bottom bound it stops at 4, not below.
    for (let i = 0; i < 5; i += 1) g.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('4');

    // Home / End jump to the bounds.
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('8');
    g.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('4');
  });

  it('clamps a drag that goes past the bounds', async () => {
    mountHarness({ items: 10 });
    await flush();
    stubGeometry(host!, 10, 6);
    await remeasure();

    const g = grip();
    g.setPointerCapture = () => undefined;
    g.releasePointerCapture = () => undefined;

    // A huge upward drag asks for far more than 8 rows.
    g.dispatchEvent(Object.assign(new Event('pointerdown'), { clientY: 500, pointerId: 1 }));
    g.dispatchEvent(Object.assign(new Event('pointermove'), { clientY: 0, pointerId: 1 }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('8');

    g.dispatchEvent(Object.assign(new Event('pointerup'), { clientY: 0, pointerId: 1 }));
    // And far downward asks for fewer than 4.
    g.dispatchEvent(Object.assign(new Event('pointerdown'), { clientY: 0, pointerId: 2 }));
    g.dispatchEvent(Object.assign(new Event('pointermove'), { clientY: 5000, pointerId: 2 }));
    await flush();
    expect(g.getAttribute('aria-valuenow')).toBe('4');
  });

  it('persists the chosen row count', async () => {
    mountHarness({ items: 10, storageKey: 'rows-key' });
    await flush();
    stubGeometry(host!, 10, 6);
    await flush();

    grip().dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }));
    await flush();

    expect(localStorage.getItem('rows-key')).toBe('8');
  });

  it('does not respond to a drag before it starts', async () => {
    // A pointermove with no preceding pointerdown must be ignored, otherwise merely
    // moving the mouse across the grip would resize the list.
    mountHarness({ items: 10 });
    await flush();
    stubGeometry(host!, 10, 6);
    await remeasure();

    const g = grip();
    g.dispatchEvent(Object.assign(new Event('pointermove'), { clientY: 0, pointerId: 1 }));
    await flush();

    expect(g.getAttribute('aria-valuenow')).toBe('6');
  });
});
