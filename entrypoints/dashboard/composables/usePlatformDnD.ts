import { computed, ref } from 'vue';

/**
 * Drag-and-drop ordering for the feed sidebar's platform list.
 *
 * Extracted from `FeedView.vue` (2026-09-11) where it occupied the top of the
 * script with no dependency on anything else in the view: three refs, three
 * handlers, and one derived list. The only things it needs from the view are the
 * stored order, the known platform keys, and a way to report the new order — all
 * passed in, so the composable reads no context of its own.
 *
 * The drop handler is the part worth keeping in one piece: the index arithmetic
 * has to move the dragged key to the position of the key it was dropped on, and
 * `splice` inside `splice` is exactly the kind of line that reads as a no-op when
 * it is wrong.
 */
export function usePlatformDnD(deps: {
  /** The user's stored order (platform keys). */
  platformOrder: () => string[];
  /** Every platform key the registry knows, in registry order. */
  registryKeys: () => string[];
  /** Reports the reordered list; the view persists it. */
  onReorder: (order: string[]) => void;
}) {
  /**
   * Ordered platform keys: the user's order first, then any platform it does not
   * mention, in registry order. A newly added platform therefore appears at the
   * end rather than being dropped from the sidebar.
   */
  const orderedPlatformKeys = computed<string[]>(() => {
    const keys = deps.registryKeys();
    const userOrder = deps.platformOrder().filter((k) => keys.includes(k));
    const rest = keys.filter((k) => !userOrder.includes(k));
    return [...userOrder, ...rest];
  });

  const dragPlatformKey = ref<string | null>(null);
  const dragOverPlatformKey = ref<string | null>(null);

  function onPlatformDragStart(key: string) {
    dragPlatformKey.value = key;
  }

  function onPlatformDragOver(e: DragEvent, key: string) {
    if (dragPlatformKey.value === null || dragPlatformKey.value === key) return;
    e.preventDefault();
    dragOverPlatformKey.value = key;
  }

  function onPlatformDrop(key: string) {
    const from = dragPlatformKey.value;
    if (from === null || from === key) {
      dragPlatformKey.value = null;
      dragOverPlatformKey.value = null;
      return;
    }
    const next = [...orderedPlatformKeys.value];
    const fromIdx = next.indexOf(from);
    const toIdx = next.indexOf(key);
    if (fromIdx !== -1 && toIdx !== -1) {
      next.splice(toIdx, 0, next.splice(fromIdx, 1)[0]);
      deps.onReorder(next);
    }
    dragPlatformKey.value = null;
    dragOverPlatformKey.value = null;
  }

  return {
    orderedPlatformKeys,
    dragPlatformKey,
    dragOverPlatformKey,
    onPlatformDragStart,
    onPlatformDragOver,
    onPlatformDrop,
  };
}
