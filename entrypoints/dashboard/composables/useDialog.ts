import { ref, type Ref } from 'vue';

/**
 * Imperative dialog service (audit P2-20).
 *
 * The dashboard called `alert()` / `confirm()` in 48 places. Those are native
 * modals: unstyleable, blocking the *renderer* rather than just the page (so
 * they also block CDP, which the release gate has to work around), and absent
 * from the app's own design language. Every one of them is also unawaitable in
 * a way the UI can render — `confirm()` freezes the tab.
 *
 * The shape here is deliberately `alert`/`confirm`-like so a call site changes
 * from `if (!confirm(msg)) return;` to `if (!(await dialog.confirm(msg))) return;`
 * — one word, no restructuring. `DialogHost.vue` renders whatever is queued.
 *
 * Deliberately NOT a promise-per-call map: only one dialog is shown at a time
 * (a modal is exclusive by nature), so the service holds the current request and
 * the next one queues behind it. That also matches user expectation — two
 * confirms stacked is never what was meant.
 */

export interface DialogRequest {
  /** Stable id so the host can key the element and close exactly once. */
  id: number;
  kind: 'alert' | 'confirm';
  message: string;
  /** Optional heading; most call sites pass only a message. */
  title?: string;
  /** Confirm-button label; defaults differ by kind. */
  confirmLabel?: string;
  /** Cancel-button label (confirm only). */
  cancelLabel?: string;
}

interface PendingDialog extends DialogRequest {
  resolve: (value: boolean) => void;
}

const queue = ref<PendingDialog[]>([]);
let nextId = 1;

/** The dialog currently on screen, or null. */
export const activeDialog: Ref<PendingDialog | null> = ref(null);

function enqueue(request: Omit<DialogRequest, 'id'>, resolve: (value: boolean) => void): void {
  const pending: PendingDialog = { ...request, id: nextId++, resolve };
  if (activeDialog.value === null) {
    activeDialog.value = pending;
  } else {
    queue.value = [...queue.value, pending];
  }
}

/**
 * Close the current dialog and show the next one, if any.
 *
 * Called by the host with the user's answer; the answer is `true` for alert
 * (nothing to decline) and for a confirmed prompt.
 */
export function settleDialog(id: number, value: boolean): void {
  const current = activeDialog.value;
  if (!current || current.id !== id) return;
  current.resolve(value);
  const [next, ...rest] = queue.value;
  queue.value = rest;
  activeDialog.value = next ?? null;
}

/** Message-only acknowledgement. Resolves when dismissed. */
function alert(message: string, opts: { title?: string; confirmLabel?: string } = {}): Promise<void> {
  return new Promise<void>((resolve) => {
    enqueue({ kind: 'alert', message, ...opts }, () => resolve());
  });
}

/** Yes/no prompt. Resolves `true` on confirm, `false` on cancel/Escape/backdrop. */
function confirm(
  message: string,
  opts: { title?: string; confirmLabel?: string; cancelLabel?: string } = {},
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    enqueue({ kind: 'confirm', message, ...opts }, resolve);
  });
}

export const dialog = { alert, confirm };

/**
 * Test seam: drop everything queued and reset the id counter.
 *
 * The queue is module state shared by every component, so a test that leaves a
 * dialog open would leak into the next test file's render.
 */
export function resetDialogs(): void {
  for (const pending of [activeDialog.value, ...queue.value]) pending?.resolve(false);
  activeDialog.value = null;
  queue.value = [];
  nextId = 1;
}
