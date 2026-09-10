import { computed, onMounted, onUnmounted, ref } from 'vue';
import {
  DEV_LOG_LEVELS,
  devLog,
  type DevLogEntry,
  type DevLogLevel,
} from '../../../src/utils/devLog';

/**
 * Dashboard-side view of the developer log (`src/utils/devLog.ts`).
 *
 * Owns only presentation state — level/scope/text filters and the verbose
 * switch. The buffer itself lives in `chrome.storage.session`, so a subscription
 * here also surfaces entries written by the background service worker.
 */
export function useDevLog() {
  const entries = ref<DevLogEntry[]>([]);
  const levelFilter = ref<DevLogLevel | 'all'>('all');
  const scopeFilter = ref('all');
  const textFilter = ref('');
  const verbose = ref(false);

  let unsubscribe: (() => void) | null = null;

  onMounted(async () => {
    verbose.value = await devLog.isVerbose();
    unsubscribe = devLog.subscribe((next) => {
      entries.value = next;
    });
  });

  onUnmounted(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  /** Scopes actually present, so the dropdown never offers an empty filter. */
  const scopes = computed(() =>
    [...new Set(entries.value.map((e) => e.scope))].sort((a, b) => a.localeCompare(b)),
  );

  const visibleEntries = computed(() =>
    devLog.filter(entries.value, {
      level: levelFilter.value,
      scope: scopeFilter.value,
      text: textFilter.value,
    }),
  );

  const counts = computed(() => {
    const byLevel: Record<DevLogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const entry of entries.value) byLevel[entry.level] += 1;
    return { byLevel, total: entries.value.length };
  });

  async function toggleVerbose() {
    verbose.value = !verbose.value;
    await devLog.setVerbose(verbose.value);
  }

  async function clearLog() {
    await devLog.clear();
  }

  /** Copy the visible entries, newest last, for pasting into a bug report. */
  async function copyVisible(): Promise<boolean> {
    const text = devLog.toText(visibleEntries.value);
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  return {
    entries,
    visibleEntries,
    levelFilter,
    scopeFilter,
    textFilter,
    verbose,
    scopes,
    counts,
    levels: DEV_LOG_LEVELS,
    toggleVerbose,
    clearLog,
    copyVisible,
    formatTime: (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour12: false }),
  };
}
