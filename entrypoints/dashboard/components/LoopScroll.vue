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
/** Height of the shortest row — an expanded card must not inflate the row height. */
const rowHeight = ref(0);
/** Gap between rows, derived from the rendered geometry (see `measure`). */
const gapPx = ref(0);
const viewportCap = ref(0);

/** What one additional row adds: its own height plus the gap above it. */
const rowPitch = computed(() => rowHeight.value + gapPx.value);

/** `rows` rows, capped so the grip stays reachable on a short window. */
const heightPx = computed(() => {
  if (rowHeight.value <= 0 || visibleRows.value <= 0) return 0;
  const wanted = visibleRows.value * rowHeight.value + (visibleRows.value - 1) * gapPx.value;
  const cap = viewportCap.value > 0 ? viewportCap.value : Number.POSITIVE_INFINITY;
  // Never collapse below a single row, even when the window is shorter than the cap.
  return Math.max(rowHeight.value, Math.min(wanted, cap));
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
    rowHeight.value = 0;
    gapPx.value = 0;
    return;
  }
  // Derive the gap rather than reading it: the wrapper's spacing comes from a Tailwind
  // utility whose mechanism (margin versus `row-gap`) is an implementation detail, and
  // only the rendered geometry is dependable.
  const itemsHeight = items.reduce((sum, item) => sum + item.offsetHeight, 0);
  gapPx.value = items.length > 1 ? Math.max(0, (first.offsetHeight - itemsHeight) / (items.length - 1)) : 0;
  rowHeight.value = Math.min(...items.map((item) => item.offsetHeight));
}

function measureCap() {
  viewportCap.value = props.capToViewport > 0 ? Math.max(0, window.innerHeight - props.capToViewport) : 0;
}

/**
 * Keep `scrollTop` inside the first copy.
 *
 * The copies are identical, so subtracting one copy's height is invisible. It cannot
 * loop forever either: the result is always `< copyHeight`, which this function leaves
 * alone, so the scroll event it triggers is a no-op.
 */
function onScroll() {
  const el = viewport.value;
  if (!el) return;
  if (copies.value < 2 || copyHeight.value <= 0) return;
  if (el.scrollTop >= copyHeight.value) {
    el.scrollTop -= copyHeight.value;
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

function onGripPointerDown(event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  dragging.value = true;
  dragStartY = event.clientY;
  dragStartRows = visibleRows.value;
}

function onGripPointerMove(event: PointerEvent) {
  if (!dragging.value) return;
  const pitch = rowPitch.value > 0 ? rowPitch.value : 1;
  // Dragging up grows the list: the grip follows the pointer's edge.
  setRows(dragStartRows + (dragStartY - event.clientY) / pitch);
}

function onGripPointerUp(event: PointerEvent) {
  if (!dragging.value) return;
  (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  dragging.value = false;
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
      class="overflow-y-auto overflow-x-hidden overscroll-contain scrollbar-thin pr-0.5"
      :style="{ height: heightPx > 0 ? `${heightPx}px` : undefined, scrollBehavior: 'auto' }"
      :aria-label="ariaLabel"
      role="group"
      tabindex="0"
      @scroll.passive="onScroll"
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
      class="mt-1.5 -mb-0.5 flex w-full cursor-ns-resize items-center justify-center gap-1 rounded-lg py-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-500 dark:hover:bg-slate-800 dark:hover:text-slate-300"
      :class="{ 'bg-indigo-50 text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300': dragging }"
      @pointerdown="onGripPointerDown"
      @pointermove="onGripPointerMove"
      @pointerup="onGripPointerUp"
      @pointercancel="onGripPointerUp"
      @keydown="onGripKeydown"
    >
      <GripHorizontal class="h-3.5 w-3.5" aria-hidden="true" />
      <span class="text-[10px] font-medium tabular-nums">{{ visibleRows }} 行</span>
    </div>
  </div>
</template>
