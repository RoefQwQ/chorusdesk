<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { ArrowUp, BookmarkCheck, BookmarkPlus, MapPin, Check } from 'lucide-vue-next';

const currentScrollY = ref(0);
const markedScrollY = ref<number | null>(null);
const showToast = ref(false);
let toastTimer: ReturnType<typeof setTimeout> | null = null;

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
  } catch {}

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
  } catch {}
});

onUnmounted(() => {
  window.removeEventListener('scroll', updateScroll);
  if (toastTimer) clearTimeout(toastTimer);
});
</script>

<template>
  <!-- Floating Action Group Container -->
  <aside
    class="relative flex flex-col items-center gap-2 select-none"
    aria-label="页面快捷导航"
  >
    <!-- Toast Popup Notification -->
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
        class="absolute bottom-full mb-3 left-1/2 -translate-x-1/2 whitespace-nowrap px-3 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-xs font-medium shadow-xl flex items-center gap-1.5 backdrop-blur-md pointer-events-none"
      >
        <Check class="w-3.5 h-3.5 text-emerald-400 dark:text-emerald-600" />
        <span>已标记当前浏览位置</span>
      </div>
    </Transition>

    <div class="flex flex-col items-center gap-1.5 p-1.5 bg-white/90 dark:bg-slate-900/90 backdrop-blur-md border border-slate-200/80 dark:border-slate-800 shadow-xl rounded-2xl">
      <!-- 1. Jump back to marked position -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 scale-75"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-75"
      >
        <button
          v-if="canJumpToMark"
          type="button"
          @click="jumpToMarkedPosition"
          class="w-9 h-9 flex items-center justify-center rounded-xl bg-amber-500 hover:bg-amber-600 text-white shadow-md shadow-amber-500/25 transition-all active:scale-95 cursor-pointer group relative"
          :title="`回到标记位置 (${Math.round(markedScrollY || 0)}px)`"
        >
          <BookmarkCheck class="w-4 h-4" />
          <span class="sr-only">回到标记位置</span>
        </button>
      </Transition>

      <!-- 2. Mark current scroll position -->
      <button
        type="button"
        @click="markCurrentPosition"
        class="w-9 h-9 flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all active:scale-95 cursor-pointer relative"
        :title="markedScrollY !== null ? `重新标记当前位置 (上次标记在 ${Math.round(markedScrollY)}px)` : '标记当前浏览位置'"
      >
        <BookmarkPlus v-if="markedScrollY === null" class="w-4 h-4" />
        <MapPin v-else class="w-4 h-4 text-indigo-500 dark:text-indigo-400" />
        <span
          v-if="markedScrollY !== null"
          class="absolute top-1.5 right-1.5 w-1.5 h-1.5 rounded-full bg-amber-500 ring-2 ring-white dark:ring-slate-900"
        ></span>
        <span class="sr-only">标记当前位置</span>
      </button>

      <!-- 3. Back to top -->
      <Transition
        enter-active-class="transition duration-200 ease-out"
        enter-from-class="opacity-0 scale-75"
        enter-to-class="opacity-100 scale-100"
        leave-active-class="transition duration-150 ease-in"
        leave-from-class="opacity-100 scale-100"
        leave-to-class="opacity-0 scale-75"
      >
        <button
          v-if="showBackToTop"
          type="button"
          @click="scrollToTop"
          class="w-9 h-9 flex items-center justify-center rounded-xl text-slate-600 dark:text-slate-300 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-all active:scale-95 cursor-pointer"
          title="回到顶部"
        >
          <ArrowUp class="w-4 h-4" />
          <span class="sr-only">回到顶部</span>
        </button>
      </Transition>
    </div>
  </aside>
</template>
