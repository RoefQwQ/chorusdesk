<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, type Component } from 'vue';
import { ArrowUp, BookmarkCheck, BookmarkPlus, MapPin, Check } from 'lucide-vue-next';

/**
 * Floating reading-position controls: back to top, mark this spot, jump to the mark.
 *
 * Redesigned 2026-09-11. The behaviour is unchanged — only how it reads. Reported as
 * 「最下方的这个回顶按钮看起来需要重新设计外观」, and the screenshot showed why: two
 * icon-only squares stacked loosely, with no shared container, no labels, and icons
 * that are unrecognisable at a glance (a blurred bookmark glyph tells the user
 * nothing). Concretely, the problems were:
 *
 * 1. **No group.** The wrapper's border was too faint, so the buttons read as stray
 *    squares floating over the feed. Now a single solid pill with a visible border and
 *    a shadow, so it reads as one control.
 * 2. **No words.** `title` attributes only appear after a slow hover and never for
 *    keyboard or touch. Each control now shows its name in a real label, on hover
 *    *and* on focus, positioned to the left of the pill.
 * 3. **Inconsistent weight.** The jump-to-mark control was an amber-filled block,
 *    which made a secondary action look like the primary one. Everything is now a
 *    uniform ghost button; state is carried by a small indicator on the icon, and
 *    hover/focus by a tint, so no control shouts.
 * 4. **Three copies of the styling.** The three buttons were styled in three places,
 *    which is how they drifted apart. They are now driven by one list, so a control
 *    cannot end up looking different from its siblings.
 *
 * The order is fixed as: jump-to-mark, mark, back-to-top — so the bottom-most button
 * is always 回到顶部, which is the one the user pointed at.
 *
 * The label visibility is driven by Vue state rather than CSS `group-hover`, because a
 * Tailwind utility that the content scanner fails to emit would silently never show —
 * the same class of failure this project has been bitten by before.
 */

const currentScrollY = ref(0);
const markedScrollY = ref<number | null>(null);
const showToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** Which control is being pointed at or focused, so its name can be shown. */
const activeId = ref<string | null>(null);

// Storage key for keeping marked scroll position across soft refreshes
const STORAGE_KEY = 'cfh_marked_scroll_y';

function updateScroll() {
  currentScrollY.value = window.scrollY || document.documentElement.scrollTop || 0;
}

function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function markCurrentPosition() {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  markedScrollY.value = y;
  try {
    sessionStorage.setItem(STORAGE_KEY, String(Math.round(y)));
  } catch {
    // sessionStorage unavailable (privacy mode): mark lives only in memory.
  }

  showToast.value = true;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    showToast.value = false;
  }, 2200);
}

function jumpToMarkedPosition() {
  if (markedScrollY.value !== null) {
    window.scrollTo({ top: markedScrollY.value, behavior: 'smooth' });
  }
}

// Show "Jump to mark" if we have a mark and we are away from it (> 120px diff)
const canJumpToMark = computed(() => {
  if (markedScrollY.value === null) return false;
  return Math.abs(currentScrollY.value - markedScrollY.value) > 120;
});

// Show "Back to top" button if scroll position is beyond 300px
const showBackToTop = computed(() => currentScrollY.value > 300);

interface ToolbarAction {
  id: string;
  /** Shown in the label, and used as the accessible name. */
  label: string;
  icon: Component;
  onClick: () => void;
  /** Small state marker on the icon (used for "a position is marked"). */
  dot?: boolean;
}

/** One list, one set of styles: the anti-drift measure from problem 4 above. */
const actions = computed<ToolbarAction[]>(() => {
  const list: ToolbarAction[] = [];

  if (canJumpToMark.value) {
    list.push({
      id: 'jump',
      label: `回到标记位置`,
      icon: BookmarkCheck,
      onClick: jumpToMarkedPosition,
    });
  }

  const marked = markedScrollY.value !== null;
  list.push({
    id: 'mark',
    label: marked ? '重新标记当前位置' : '标记当前浏览位置',
    icon: marked ? MapPin : BookmarkPlus,
    onClick: markCurrentPosition,
    dot: marked,
  });

  if (showBackToTop.value) {
    list.push({ id: 'top', label: '回到顶部', icon: ArrowUp, onClick: scrollToTop });
  }

  return list;
});

function activate(action: ToolbarAction) {
  activeId.value = null;
  action.onClick();
}

onMounted(() => {
  window.addEventListener('scroll', updateScroll, { passive: true });
  updateScroll();

  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved !== null) {
      const parsed = Number(saved);
      if (!Number.isNaN(parsed) && parsed > 0) {
        markedScrollY.value = parsed;
      }
    }
  } catch {
    // sessionStorage unavailable: start without a saved mark.
  }
});

onUnmounted(() => {
  window.removeEventListener('scroll', updateScroll);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <!-- Floating action group -->
  <aside
    class="relative flex flex-col items-center gap-0.5 rounded-2xl border border-slate-200/90 bg-white/95 p-1 shadow-lg shadow-slate-900/10 backdrop-blur-md dark:border-slate-700/80 dark:bg-slate-900/95"
    aria-label="页面快捷导航"
  >
    <!-- Toast: confirms the mark landed, which the icon alone cannot convey. -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="opacity-0 translate-y-2 scale-95"
      enter-to-class="opacity-100 translate-y-0 scale-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100 scale-100"
      leave-to-class="opacity-0 scale-95"
    >
      <div
        v-if="showToast"
        class="pointer-events-none absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900/92 px-2.5 py-1.5 text-[11px] font-medium text-white shadow-lg backdrop-blur-md dark:bg-white/95 dark:text-slate-900"
      >
        <Check class="h-3 w-3 text-emerald-400 dark:text-emerald-600" />
        <span>已标记当前浏览位置</span>
      </div>
    </Transition>

    <!-- One definition per action: uniform size, shape, hover and focus treatment. -->
    <button
      v-for="action in actions"
      :key="action.id"
      type="button"
      :aria-label="action.label"
      :title="action.label"
      class="group/btn relative flex h-8 w-8 cursor-pointer items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-indigo-50 hover:text-indigo-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 active:scale-95 dark:text-slate-400 dark:hover:bg-indigo-950/60 dark:hover:text-indigo-300 dark:focus-visible:ring-offset-slate-900"
      @click="activate(action)"
      @mouseenter="activeId = action.id"
      @mouseleave="activeId = null"
      @focus="activeId = action.id"
      @blur="activeId = null"
    >
      <component :is="action.icon" class="h-4 w-4" aria-hidden="true" />
      <!-- "A position is marked" — a marker, not a second button. -->
      <span
        v-if="action.dot"
        class="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-indigo-500 ring-2 ring-white dark:ring-slate-900"
        aria-hidden="true"
      ></span>

      <!-- The label lives to the LEFT of the pill, so it never covers the icon. -->
      <span
        v-if="activeId === action.id"
        class="pointer-events-none absolute right-full top-1/2 mr-2 -translate-y-1/2 whitespace-nowrap rounded-lg bg-slate-900/92 px-2 py-1 text-[11px] font-medium text-white shadow-lg dark:bg-white/95 dark:text-slate-900"
      >
        {{ action.label }}
      </span>
    </button>
  </aside>
</template>
