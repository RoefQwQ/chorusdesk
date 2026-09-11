<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { GripHorizontal } from 'lucide-vue-next';

/**
 * LoopScroll — a fixed-height scroll viewport whose content wraps seamlessly, and
 * optionally resizes by dragging a grip.
 *
 * Built for the feed's creator sidebar (2026-09-11): the list had a plain
 * `max-h-[calc(100vh-210px)] overflow-y-auto`, which ends in a hard stop, and its
 * height was not adjustable at all.
 *
 * ## How the seamless wrap works
 *
 * The content is rendered **twice** and `scrollTop` is kept inside the range of the
 * first copy: reaching the end of copy 1 writes `scrollTop -= copyHeight`, landing on
 * the identical pixel in copy 2. Because the copies are byte-identical nothing moves
 * visibly, so there is no seam to hide. Two copies suffice because the wrap is
 * one-directional (「从上到下循环」); the top of the list stays a real stop, which is
 * what the start of a list should be.
 *
 * Two properties make this work with the actual content rather than an idealised one:
 *
 * - **`copyHeight` is measured, not assumed.** Rows here expand inline and are
 *   therefore variable-height, which rules out the obvious virtualisation (absolute
 *   offsets from a fixed pitch). Wrapping on the measured height of a whole copy is
 *   indifferent to how tall any individual row is.
 * - **A copy shorter than the viewport means there is nothing to scroll**, so the
 *   second copy is dropped and this degrades to a plain list.
 *
 * ## The accessibility cost, stated plainly
 *
 * The second copy is `aria-hidden`, so assistive tech sees one list, not two. It stays
 * **clickable**, because it is genuinely on screen once the user has scrolled into it —
 * making it inert would render the visible rows dead to the mouse. So its controls are
 * reachable by mouse but not by Tab. Nothing becomes unreachable: every control also
 * exists in the first copy. A duplicate-free version would have to take scrolling over
 * entirely (transform + synthetic wheel handling), giving up the native scrollbar and
 * keyboard scrolling; that is not worth it for a sidebar.
 */

const props = withDefaults(
  defineProps<{
    /**
     * Items per copy. Not used for the height — it only tells this component when the
     * data changed, so a re-measure can be scheduled.
     */
    itemCount: number;
    /** Visible row count when nothing is stored yet. */
    rows?: number;
    minRows?: number;
    maxRows?: number;
    /** localStorage key for the row count. Omitted ⇒ in-memory only. */
    storageKey?: string;
    /** Render the drag grip. */
    resizable?: boolean;
    /**
     * Wrap around instead of stopping at the end. Off ⇒ an ordinary capped scroller,
     * which is what the left platform list wants.
     */
    loop?: boolean;
    /**
     * Cap the height to `window.innerHeight - capToViewport` px. The sidebar is pinned
     * with `lg:sticky`, so a card taller than the viewport would put its own grip out
     * of reach.
     */
    capToViewport?: number;
    ariaLabel?: string;
  }>(),
  {
    rows: 6,
    minRows: 4,
    maxRows: 8,
    resizable: false,
    loop: true,
    capToViewport: 0,
  },
);

function clampRows(value: number): number {
  return Math.min(props.maxRows, Math.max(props.minRows, Math.round(value)));
}

/** Seeded from storage, and clamped: a hand-edited value must not break the layout. */
function readStoredRows(): number {
  if (!props.storageKey) return clampRows(props.rows);
  try {
    const raw = localStorage.getItem(props.storageKey);
    if (raw === null) return clampRows(props.rows);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampRows(parsed) : clampRows(props.rows);
  } catch {
    // localStorage unavailable (private mode): fall back to the default.
    return clampRows(props.rows);
  }
}

const visibleRows = ref(readStoredRows());

function setRows(value: number) {
  const next = clampRows(value);
  if (next === visibleRows.value) return;
  visibleRows.value = next;
  if (props.storageKey) {
    try {
      localStorage.setItem(props.storageKey, String(next));
    } catch {
      // Persisting is best-effort; the layout still works for this session.
    }
  }
}

const viewport = ref<HTMLElement | null>(null);
/** Height of one copy of the content, measured from the DOM. */
const copyHeight = ref(0);
/** Rendered height of each row in a copy, in order. */
const rowHeights = ref<number[]>([]);
/** Cumulative top offset of each row within a copy — the scroll snap positions. */
const rowTops = ref<number[]>([]);
/** Gap between rows, derived from the rendered geometry (see `measure`). */
const gapPx = ref(0);
const viewportCap = ref(0);

/**
 * Average cost of one row, gap included: `copyHeight` is `sum(heights) + (n - 1) * gap`,
 * so adding one more gap divides evenly by `n`. Only drag-to-resize needs a scalar — it
 * maps a pixel delta onto a row count — and an average is the honest value when the
 * rows differ, which they do as soon as a name wraps or a card is expanded.
 */
const rowPitch = computed(() => {
  const n = rowHeights.value.length;
  return n === 0 ? 0 : (copyHeight.value + gapPx.value) / n;
});

/**
 * The height of `rows` rows, snapped down to a row boundary.
 *
 * Sized by summing the rows that will actually be on screen, *not* by
 * `rows × shortestRow`. Measured 2026-09-12: `miko鲜葱日记`'s card is taller than its
 * neighbours, so an `8 × shortest` container cut the eighth row in half — and every
 * wheel notch then landed between two rows, which is what 「滚动时上下截断」 was. The
 * viewport edge has to fall on a row boundary, or no amount of scroll arithmetic can
 * make one notch show exactly one row.
 *
 * The cap is snapped for the same reason: backing off to the last row that fits beats
 * showing most of one.
 */
const heightPx = computed(() => {
  const rows = visibleRows.value;
  const heights = rowHeights.value;
  if (rows <= 0 || heights.length === 0) return 0;

  const taken = Math.min(rows, heights.length);
  let wanted = heights[0];
  for (let i = 1; i < taken; i++) wanted += gapPx.value + heights[i];

  const cap = viewportCap.value > 0 ? viewportCap.value : Number.POSITIVE_INFINITY;
  if (wanted <= cap) return wanted;

  // Largest row boundary that still fits. Never zero: one row is the floor even when
  // the window is shorter than that.
  let fit = 0;
  for (let i = 0; i < taken; i++) {
    const bottom = rowTops.value[i] + heights[i];
    if (bottom > cap) break;
    fit = bottom;
  }
  return fit > 0 ? fit : Math.min(heights[0], cap);
});

/**
 * A second copy exists only to give the wrap somewhere to land, so it is only worth
 * rendering when one copy is tall enough to be scrollable at all.
 */
const copies = computed(() => {
  if (!props.loop) return 1;
  if (copyHeight.value <= 0 || heightPx.value <= 0) return 1;
  return copyHeight.value > heightPx.value ? 2 : 1;
});

function measure() {
  const el = viewport.value;
  if (!el) return;
  // The first child IS the first copy; no marker attribute needed.
  const first = el.firstElementChild as HTMLElement | null;
  if (!first) return;

  copyHeight.value = first.offsetHeight;

  const items = [...first.children] as HTMLElement[];
  if (items.length === 0) {
    rowHeights.value = [];
    rowTops.value = [];
    gapPx.value = 0;
    return;
  }
  // Derive the gap rather than reading it: the wrapper's spacing comes from a Tailwind
  // utility whose mechanism (margin versus `row-gap`) is an implementation detail, and
  // only the rendered geometry is dependable.
  const itemsHeight = items.reduce((sum, item) => sum + item.offsetHeight, 0);
  gapPx.value = items.length > 1 ? Math.max(0, (first.offsetHeight - itemsHeight) / (items.length - 1)) : 0;
  rowHeights.value = items.map((item) => item.offsetHeight);

  // Snap positions, relative to the copy's top. Read from the live boxes rather than
  // accumulated from the heights above: `offsetTop` already includes the gap and any
  // margin the slot adds, so it is right even if the wrapper's spacing mechanism
  // changes.
  const copyTop = first.getBoundingClientRect().top;
  rowTops.value = items.map((item) => item.getBoundingClientRect().top - copyTop);
}

function measureCap() {
  viewportCap.value = props.capToViewport > 0 ? Math.max(0, window.innerHeight - props.capToViewport) : 0;
}

/**
 * Keep `scrollTop` inside the first copy, and on a row boundary.
 *
 * The copies are identical, so subtracting one copy's height is invisible. It cannot
 * loop forever either: the result is always `< copyHeight`, which this function leaves
 * alone, so the scroll event it triggers is a no-op.
 */
function onScroll() {
  const el = viewport.value;
  if (!el) return;
  if (copies.value >= 2 && copyHeight.value > 0 && el.scrollTop >= copyHeight.value) {
    el.scrollTop -= copyHeight.value;
  }
  snapToRow(el);
}

/**
 * Settle on the nearest row boundary.
 *
 * Reported 2026-09-12: 「滚动的时候不能完美的滚动一次轮换1个创作者，而是上下截断」. Two causes,
 * and this is the one that does not depend on the input device: a wheel notch, a
 * trackpad flick, `PageDown` and a scrollbar drag all produce an arbitrary pixel
 * offset, so the viewport edge lands mid-row and the next row is shown cut off.
 *
 * Only boundaries inside `[0, maxScroll]` are considered: at the bottom of a
 * **non-looping** list the last screen is legitimately partial, and aiming at an
 * unreachable offset would spin (the browser clamps it, the next event sees the same
 * distance, and it tries again).
 *
 * The 1px tolerance is what makes the second pass a no-op rather than a loop.
 */
function snapToRow(el: HTMLElement) {
  const tops = rowTops.value;
  if (tops.length === 0) return;
  const max = el.scrollHeight - el.clientHeight;
  const current = el.scrollTop;
  let best = -1;
  let bestDistance = Infinity;
  for (const top of tops) {
    if (top < 0 || top > max) continue;
    const distance = Math.abs(top - current);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = top;
    }
  }
  if (best < 0 || bestDistance <= 1) return;
  el.scrollTop = best;
}

/**
 * Move exactly one row, in the direction of `direction` (+1 down, -1 up).
 *
 * This is the other half of the report: a native notch is ~100px against a ~57px row,
 * so even with snapping the row count per notch would vary between one and two. One
 * notch, one row, is what the list should feel like.
 *
 * Going down past the last row targets the second copy's first row — identical content
 * one copy-height away — and `onScroll` wraps it back, which is the same mechanism the
 * seamless loop already uses. Going up from the top does nothing: the top of the list
 * is a real stop, by design.
 */
function stepRows(direction: number) {
  const el = viewport.value;
  const tops = rowTops.value;
  if (!el || tops.length === 0) return;
  const current = el.scrollTop;
  let target = -1;
  if (direction > 0) {
    target = tops.find((top) => top > current + 1) ?? -1;
    if (target < 0 && copies.value >= 2) target = copyHeight.value + tops[0];
  } else {
    for (const top of tops) if (top < current - 1) target = Math.max(target, top);
  }
  if (target < 0) return;
  el.scrollTop = target;
}

/**
 * How long after a step further wheel events are treated as the same gesture.
 *
 * A trackpad sends dozens of events per flick and a mouse sends a momentum tail after
 * the notch, so without a lock one gesture would advance the list by however many
 * events fit in a frame. 140ms is below the interval between two deliberate notches
 * and above the tail of one flick.
 */
const WHEEL_GESTURE_MS = 140;
let wheelLockUntil = 0;

function onWheel(event: WheelEvent) {
  const el = viewport.value;
  if (!el || rowTops.value.length === 0) return;
  // deltaMode: 0 = pixels, 1 = lines, 2 = pages.
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? el.clientHeight : 1;
  const delta = event.deltaY * unit;
  if (delta === 0) return;
  // Only claimed once this handler is going to act on it, so a horizontal flick on a
  // trackpad still scrolls whatever is behind the list normally.
  event.preventDefault();
  const now = event.timeStamp || performance.now();
  if (now < wheelLockUntil) return;
  wheelLockUntil = now + WHEEL_GESTURE_MS;
  stepRows(delta > 0 ? 1 : -1);
}

/**
 * Arrow / PageUp / PageDown move by whole rows too.
 *
 * The browser's own arrow-key scroll is ~40px, which lands mid-row for the same reason
 * a wheel notch does. `Home`/`End` are left alone: they go to the list's real ends,
 * which is what those keys mean.
 */
function onViewportKeydown(event: KeyboardEvent) {
  if (event.key === 'ArrowDown' || event.key === 'PageDown') {
    event.preventDefault();
    stepRows(1);
  } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault();
    stepRows(-1);
  }
}

let observer: ResizeObserver | null = null;
let frame = 0;

/** Coalesce bursts of DOM changes into one measurement per frame. */
function scheduleMeasure() {
  if (frame) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = 0;
    measure();
    onScroll();
  });
}

onMounted(() => {
  measureCap();
  window.addEventListener('resize', measureCap);
  measure();
  // Row heights depend on content (an expanded card, a wrapped name), not only on the
  // item count, so observe the copy itself rather than trusting `itemCount`.
  const first = (viewport.value?.firstElementChild ?? null) as HTMLElement | null;
  if (first && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => scheduleMeasure());
    observer.observe(first);
  }
});

onBeforeUnmount(() => {
  endDrag();
  window.removeEventListener('resize', measureCap);
  observer?.disconnect();
  observer = null;
  if (frame) cancelAnimationFrame(frame);
});

watch(() => props.itemCount, () => nextTick(scheduleMeasure));
// The height and the copy count both change what `scrollTop` may be, and the cap
// depends on the window.
watch([visibleRows, heightPx, copies, viewportCap], () => nextTick(onScroll));

// ==================== Drag-to-resize grip ====================

const dragging = ref(false);
let dragStartY = 0;
let dragStartRows = 0;

/**
 * The move/up listeners live on `window`, not on the grip.
 *
 * Reported 2026-09-11: 「按着拖动的时候互动元素不能互动了，然后就可以在点击其他内容的
 * 同时继续拖动这个高度」. Listening on the grip meant that any `pointerup` it did not
 * receive left `dragging` true forever — so the height kept following the mouse while
 * the user tried to click other things. `setPointerCapture` is *supposed* to guarantee
 * delivery, but it is released implicitly on re-render and does not survive the pointer
 * leaving the window, and a drag handle that can get stuck is worse than one that needs
 * a belt-and-braces listener. `window` cannot miss it.
 */
function onGripPointerDown(event: PointerEvent) {
  // Left button only: a right-click must not start a resize.
  if (event.button !== 0) return;
  // Stops the drag from selecting text or starting a native drag image.
  event.preventDefault();
  dragging.value = true;
  dragStartY = event.clientY;
  dragStartRows = visibleRows.value;
  window.addEventListener('pointermove', onWindowPointerMove);
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
}

function onWindowPointerMove(event: PointerEvent) {
  if (!dragging.value) return;
  // Backstop for the release the page never hears about (let go outside the window,
  // or the browser swallows the `up`). No button held means the drag is over, however
  // we got here — without this the resize would follow the mouse indefinitely.
  if (event.buttons === 0) {
    endDrag();
    return;
  }
  const pitch = rowPitch.value > 0 ? rowPitch.value : 1;
  // Dragging DOWN grows the list: the grip sits at the list's bottom edge, so the
  // bottom edge should follow the pointer. This was inverted — each step moved the
  // edge the opposite way to the hand, and the row readout ran backwards with it.
  setRows(dragStartRows + (event.clientY - dragStartY) / pitch);
}

function endDrag() {
  if (!dragging.value) return;
  dragging.value = false;
  window.removeEventListener('pointermove', onWindowPointerMove);
  window.removeEventListener('pointerup', endDrag);
  window.removeEventListener('pointercancel', endDrag);
}

/** A window splitter, so it is keyboard-operable per that pattern. */
function onGripKeydown(event: KeyboardEvent) {
  const step = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
  if (step !== 0) {
    event.preventDefault();
    setRows(visibleRows.value + step);
  } else if (event.key === 'Home') {
    event.preventDefault();
    setRows(props.minRows);
  } else if (event.key === 'End') {
    event.preventDefault();
    setRows(props.maxRows);
  }
}
</script>

<template>
  <div class="min-w-0">
    <div
      ref="viewport"
      class="no-scrollbar overflow-y-auto overflow-x-hidden overscroll-contain"
      :style="{ height: heightPx > 0 ? `${heightPx}px` : undefined, scrollBehavior: 'auto' }"
      :aria-label="ariaLabel"
      role="group"
      tabindex="0"
      @scroll.passive="onScroll"
      @wheel="onWheel"
      @keydown="onViewportKeydown"
    >
      <div
        v-for="copy in copies"
        :key="copy"
        class="space-y-2"
        :aria-hidden="copy > 1 ? 'true' : undefined"
      >
        <slot />
      </div>
    </div>

    <!-- Window-splitter grip: drag it, or use Arrow / Home / End. -->
    <div
      v-if="resizable"
      role="separator"
      aria-orientation="horizontal"
      tabindex="0"
      :aria-valuemin="minRows"
      :aria-valuemax="maxRows"
      :aria-valuenow="visibleRows"
      aria-label="拖动调整显示数量"
      :title="`拖动调整高度（${minRows}–${maxRows} 行），也可用方向键`"
      class="mt-1.5 -mb-0.5 flex w-full cursor-ns-resize touch-none select-none items-center justify-center gap-1 rounded-lg py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      :class="{ 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300': dragging }"
      @pointerdown="onGripPointerDown"
      @keydown="onGripKeydown"
    >
      <GripHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
    </div>
  </div>
</template>
