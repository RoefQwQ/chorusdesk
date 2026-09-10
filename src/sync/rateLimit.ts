import { db } from '../infrastructure/db/database';
import { getAdapter } from '../platform/registry';

/**
 * Pacing and cool-down for platform rate limits.
 *
 * The problem this exists for: repeated syncs from the UI had no effective
 * spacing. `batchSync` recorded the per-platform timestamp *before* awaiting the
 * request, so a slow platform consumed its own interval and the next request on
 * that platform started immediately. Douyin is the worst case — every request is
 * a real page load in a tab, taking several seconds — so a "sync all" issued
 * three full page loads back to back and the platform answered with a
 * verification redirect (observed: `Frame with ID 0 was removed` mid-scrape).
 *
 * Two independent mechanisms, because they answer different questions:
 *
 *  - `platformMinInterval` — a floor on the *spacing* between two requests.
 *    Applies always, and is measured from when the previous request finished.
 *  - the cool-down — a *penalty* after the platform has actually pushed back.
 *    Escalates while it keeps happening and is cleared by a clean request.
 *
 * Persisted in the settings table rather than kept in module scope: an MV3
 * service worker is torn down between syncs, so an in-memory cool-down would be
 * forgotten exactly when it matters — the user clicking sync again a moment
 * later.
 */

/** Settings key holding the cool-down map. */
const COOLDOWN_KEY = 'sync.platformCooldown';

/** First cool-down after a rate-limit signal; doubles per consecutive strike. */
export const RATE_LIMIT_BASE_MS = 60_000;

/** Ceiling, so a platform that stays hostile does not lock itself out forever. */
export const RATE_LIMIT_MAX_MS = 30 * 60_000;

/** Spacing floor for a platform that declares none. */
export const DEFAULT_MIN_INTERVAL_MS = 800;

/**
 * Spacing floor for `platform`, in ms.
 *
 * Read from the adapter (see `PlatformAdapter.minRequestIntervalMs`): the figure
 * is platform knowledge, and keeping a second table here is how it would drift
 * away from the platform it describes. An unregistered platform falls back to
 * the generic default rather than failing — pacing must not be what breaks a
 * sync.
 */
export function platformMinInterval(platform: string): number {
  return getAdapter(platform)?.minRequestIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
}

export interface PlatformCooldown {
  /** Epoch ms before which this platform must not be contacted. */
  until: number;
  /** Consecutive rate-limit signals; drives the escalating back-off. */
  strikes: number;
}

export type CooldownMap = Record<string, PlatformCooldown>;

/** Cool-down length for the `strikes`-th consecutive signal (1-based). */
export function backoffForStrike(strikes: number): number {
  const exponent = Math.max(strikes - 1, 0);
  return Math.min(RATE_LIMIT_BASE_MS * 2 ** exponent, RATE_LIMIT_MAX_MS);
}

/**
 * Read the cool-down map, discarding anything malformed.
 *
 * The value is persisted state that a half-finished write can leave in any
 * shape, and a cool-down is a *time* — a non-finite `until` would compare false
 * against every clock and silently never expire, so entries are validated rather
 * than trusted.
 */
export async function readCooldowns(): Promise<CooldownMap> {
  const row = await db.settings.get(COOLDOWN_KEY).catch(() => undefined);
  const value: unknown = row?.value;
  if (typeof value !== 'object' || value === null) return {};

  const out: CooldownMap = {};
  for (const [platform, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const { until, strikes } = record;
    if (typeof until !== 'number' || !Number.isFinite(until)) continue;
    out[platform] = {
      until,
      strikes: typeof strikes === 'number' && Number.isFinite(strikes) && strikes >= 1 ? strikes : 1,
    };
  }
  return out;
}

async function writeCooldowns(map: CooldownMap): Promise<void> {
  await db.settings.put({ key: COOLDOWN_KEY, value: map });
}

/**
 * Record a rate-limit signal for `platform` and return the resulting cool-down.
 *
 * The strike count is read from storage rather than passed in, so the escalation
 * survives worker restarts — which is the whole point of persisting it.
 */
export async function noteRateLimit(
  platform: string,
  now: number = Date.now(),
): Promise<PlatformCooldown> {
  const map = await readCooldowns();
  const strikes = (map[platform]?.strikes ?? 0) + 1;
  const entry: PlatformCooldown = { strikes, until: now + backoffForStrike(strikes) };
  map[platform] = entry;
  await writeCooldowns(map).catch(() => {
    // A failed write costs the *next* sync its head start, but must not turn a
    // rate-limit report into a thrown error: the caller still needs the code.
  });
  return entry;
}

/**
 * Clear `platform`'s cool-down after a request that succeeded.
 *
 * A clean request is the evidence that the limit has lifted, so the strikes
 * reset — otherwise a platform would creep toward the maximum cool-down over a
 * long session and stay there for reasons no longer true.
 */
export async function clearRateLimit(platform: string): Promise<void> {
  const map = await readCooldowns();
  if (!map[platform]) return;
  delete map[platform];
  await writeCooldowns(map).catch(() => {});
}

/** Remaining cool-down for `platform` in ms; `0` when it may be contacted. */
export function remainingCooldown(map: CooldownMap, platform: string, now: number = Date.now()): number {
  const entry = map[platform];
  if (!entry) return 0;
  return Math.max(0, entry.until - now);
}

/** `"3 分 20 秒"` — for a message the user reads while waiting. */
export function formatCooldown(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
