/**
 * Single-flight and platform pacing, shared by every sync entry point.
 *
 * **Why this exists.** Six paths can enter `updateChannel`: the dashboard's
 * refresh-all, refresh-creator, refresh-channel and deep-sync, the popup's
 * `SYNC_CHANNEL`, and the auto-sync alarm. Nothing coordinated them —
 * `grep inFlight|lock|mutex src/sync/` was empty — and `status: 'updating'` is a
 * field written before the fetch, not a mutex. So the same channel could be
 * acquired twice, each run holding a Channel snapshot from a different moment,
 * and whichever finished LAST won: `nextCursor` overwritten by the older run
 * (a history dig silently rewinding or skipping), `lastSuccessAt` and `status`
 * disagreeing with reality.
 *
 * That is a state-correctness failure, not a performance one, and the user could
 * not see it happen: a wrong cursor produces no error and no visible symptom
 * until a dig later returns the wrong works.
 *
 * **Why it lives here rather than in each caller.** Per-caller guards (the
 * dashboard already keeps `syncingChannelIds` in component state) cannot see
 * each other: the alarm runs in the service worker, the popup in another
 * context, and both can be alive at once. Coordination has to sit at the one
 * function all of them call.
 *
 * **Scope of the lock.** It is in-memory and per-context, which is the correct
 * scope for MV3: two contexts cannot share a JS object, but they also cannot
 * both be running the same channel's fetch without one of them going through
 * this function in *its* context. A cross-context lock would need storage-backed
 * leases with expiry, and the failure it guards (a service worker evicted
 * mid-sync) already loses the in-flight work anyway — the next run re-does it.
 * Platform pacing, which DOES need to outlive a worker, is persisted separately
 * (see `rateLimit.ts`).
 */

/** A run currently in flight for one channel id. */
interface InFlightRun {
  promise: Promise<unknown>;
  startedAt: number;
}

const inFlight = new Map<string, InFlightRun>();

/**
 * When the last request for a platform FINISHED, shared across entry points.
 *
 * `batchSync` keeps its own `platformLastFinished` per call, so two batches
 * running concurrently each start from "this platform has never been contacted"
 * and both fire immediately — defeating the spacing floor exactly when the
 * platform is about to receive the most requests. The floor is a platform's
 * protection model, so the timestamp has to be global to this context.
 */
const platformLastFinishedAt = new Map<string, number>();

/** Optional listener for observability (used by tests and the log). */
let onJoin: ((channelId: string, ageMs: number) => void) | undefined;

export function setSyncJoinListener(fn: ((channelId: string, ageMs: number) => void) | undefined): void {
  onJoin = fn;
}

/**
 * Run `task` for `channelId`, or join the run already in flight.
 *
 * The joiner receives the SAME promise, so it observes the same result rather
 * than starting a second fetch — that is the entire point: two syncs of one
 * channel must produce one fetch and one write.
 *
 * Joining is deliberately unconditional (no timeout): the alternative is a
 * second concurrent sync, which is the defect. A run that never settles holds
 * the slot, and `updateChannel`'s own 45s timeout is what bounds it.
 */
export async function withChannelRun<T>(channelId: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(channelId);
  if (existing) {
    onJoin?.(channelId, Date.now() - existing.startedAt);
    return existing.promise as Promise<T>;
  }
  const run = task();
  inFlight.set(channelId, { promise: run, startedAt: Date.now() });
  try {
    return await run;
  } finally {
    // Only clear our own entry: a joiner shares this slot and must not delete a
    // LATER run that somehow took it (defensive; the map is keyed by id and a
    // new run is only created after this one settles).
    if (inFlight.get(channelId)?.promise === run) inFlight.delete(channelId);
  }
}

/** True when a run for this channel is in flight in THIS context. */
export function isChannelRunning(channelId: string): boolean {
  return inFlight.has(channelId);
}

/** Test seam: forget every in-flight run and pacing timestamp. */
export function resetSyncCoordinator(): void {
  inFlight.clear();
  platformLastFinishedAt.clear();
}

/** Record that a request for `platform` has finished (call on every path). */
export function notePlatformFinished(platform: string, now: number = Date.now()): void {
  platformLastFinishedAt.set(platform, now);
}

/**
 * Wait until `platform` may be contacted again, given `gapMs`.
 *
 * Returns the number of ms it waited, so a caller can log it. Measuring from the
 * END of the previous request is deliberate (rule 19): a request that took longer
 * than the interval has already consumed its own spacing, and measuring from the
 * start let three Douyin page loads fire back to back.
 */
export async function waitForPlatformTurn(platform: string, gapMs: number): Promise<number> {
  const last = platformLastFinishedAt.get(platform);
  if (last === undefined) return 0;
  const elapsed = Date.now() - last;
  if (elapsed >= gapMs) return 0;
  const wait = gapMs - elapsed;
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, wait);
  await promise;
  return wait;
}
