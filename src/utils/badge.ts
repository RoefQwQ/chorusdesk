/**
 * Fire-and-forget unread-badge refresh request, sent from an extension page
 * (dashboard/popup) to the service worker.
 *
 * `updateUnreadBadge` lives in the SW (autoSync.ts) and used to run only on
 * SW startup and the 30-minute auto-sync alarm — marking posts read or
 * deleting them in the dashboard never reached it, so the toolbar badge
 * froze at a stale count forever. Pages cannot query/repaint the badge
 * themselves (chrome.action is SW-only), so they ping the SW with this
 * message after any mutation that changes the unread set.
 *
 * Calls are debounced (trailing, 200ms): feed cards mark themselves read the
 * instant they enter the viewport, so a scroll fires a burst — one badge
 * refresh per burst is enough, the SW recomputes the whole count from the
 * DB on every message anyway.
 *
 * Must NEVER be called from the service worker itself:
 * chrome.runtime.sendMessage is not delivered to the sending context
 * (AGENTS.md rule 6) — the SW refreshes its own badge via updateUnreadBadge.
 */

const DEBOUNCE_MS = 200;
let pending = false;

function sendNow(): void {
  pending = false;
  try {
    const promise = chrome.runtime?.sendMessage?.({ type: 'REFRESH_BADGE' });
    if (promise && typeof promise.catch === 'function') {
      promise.catch(() => {});
    }
  } catch {
    // Badge freshness is best-effort; never break the caller's flow.
  }
}

/** Request a badge refresh; bursts coalesce into one message. */
export function notifyBadgeRefresh(): void {
  if (pending) return;
  pending = true;
  setTimeout(sendNow, DEBOUNCE_MS);
}

/** Test hook: reset the debounce state so each case starts clean. */
export function __resetBadgeDebounce(): void {
  pending = false;
}
