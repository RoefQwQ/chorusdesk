/**
 * Developer log: a bounded, in-browser activity log the user can read from the
 * dashboard without opening devtools.
 *
 * Why it exists: the service worker is the only place several failures surface
 * (message refusals, alarm runs, auto-sync, host-grant denials), and its console
 * is impractical to reach in a packaged extension. This keeps a small ring
 * buffer in `chrome.storage.session` so the SW can contribute entries that
 * outlive it — a worker torn down mid-write loses nothing else.
 *
 * Storage choice is deliberate:
 *  - `session`, not `local`: logs are diagnostics, must never reach a backup
 *    export, and should not survive a browser restart.
 *  - bounded: a fixed-size ring, so a misbehaving loop cannot grow storage
 *    without limit or trip its quota.
 *  - no user content: entries carry hostnames, counts, and error messages — see
 *    the redaction note on `record`.
 */

export type DevLogLevel = 'debug' | 'info' | 'warn' | 'error';

/** One log line. `detail` is free text and already redacted by the caller. */
export interface DevLogEntry {
  /** Epoch ms. */
  t: number;
  level: DevLogLevel;
  /** Subsystem that produced the entry, e.g. `bgFetch`, `channelSync`. */
  scope: string;
  message: string;
  detail?: string;
  /** Which context wrote it — the SW and pages are separate realms. */
  source: 'sw' | 'page';
}

const STORAGE_KEY = 'devLog.entries';
const VERBOSE_KEY = 'devLog.verbose';
/** Ring size. ~150 entries is a few sessions of troubleshooting, a few KB. */
const MAX_ENTRIES = 150;

const LEVEL_RANK: Record<DevLogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** In-process mirror; also the fallback when `chrome.storage` is unavailable. */
let entries: DevLogEntry[] = [];
let verbose = false;
/** In-flight (or settled) hydration. Reused so concurrent callers await the same read. */
let loadPromise: Promise<void> | null = null;

/** Serializes read-modify-write cycles within this context. */
let writeChain: Promise<void> = Promise.resolve();

const listeners = new Set<(entries: DevLogEntry[]) => void>();

function sessionArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.storage?.session;
}

/** `local` area, used only to mirror the verbose switch across worker restarts. */
function browserLocalArea(): chrome.storage.StorageArea | undefined {
  return typeof chrome === 'undefined' ? undefined : chrome.storage?.local;
}

function emitChange(): void {
  for (const listener of listeners) listener([...entries]);
}

/**
 * The verbose switch as it currently stands, or `null` when neither area has an
 * opinion.
 *
 * The `local` mirror is preferred over `session`: the switch is set by the
 * dashboard panel but *consumed* by whichever context emits the log line — most
 * importantly the service worker, which is routinely evicted and restarted. A
 * session-only flag would come back `false` there, and the panel would appear to
 * do nothing at all.
 */
async function readVerboseFlag(): Promise<boolean | null> {
  const areas = [browserLocalArea(), sessionArea()];
  for (const area of areas) {
    if (!area) continue;
    try {
      const stored = await area.get(VERBOSE_KEY);
      const value = stored?.[VERBOSE_KEY];
      if (typeof value === 'boolean') return value;
    } catch {
      // Unreadable area: try the next one.
    }
  }
  return null;
}

/**
 * Hydrate from session storage, at most once per context.
 *
 * Returns the *same* promise to every caller: a plain `loaded` flag returns
 * immediately while the first read is still in flight, so an early `read()`
 * could report an empty buffer even though entries were stored.
 */
function load(): Promise<void> {
  loadPromise ??= (async () => {
    try {
      const stored = await sessionArea()?.get(STORAGE_KEY);
      entries = Array.isArray(stored?.[STORAGE_KEY]) ? (stored[STORAGE_KEY] as DevLogEntry[]) : [];
    } catch {
      // A read failure must never break the caller's flow: logging is advisory.
    }
    const flag = await readVerboseFlag();
    if (flag !== null) verbose = flag;
  })();
  return loadPromise;
}

/**
 * Re-read other contexts' entries, append ours, trim, write back, and notify.
 *
 * The SW and the dashboard can both log within the same tick, so a blind
 * `set(entries)` would drop the other's lines. Re-reading first narrows that to
 * a genuinely simultaneous write, where the loss is one diagnostic line rather
 * than the whole buffer — not worth a cross-context lock.
 */
function appendAndPersist(incoming: DevLogEntry[]): Promise<void> {
  writeChain = writeChain.then(async () => {
    // Hydrate inside the queue, not before it: `record` stays synchronous, so an
    // entry is never lost by a caller that does not await, and `flush` is exact.
    await load();
    // Resolve the switch *before* filtering: another context may have toggled it
    // since this one last looked, and a stale `false` here silently discards the
    // very lines the user just asked for.
    const flag = await readVerboseFlag();
    if (flag !== null) verbose = flag;
    const kept = incoming.filter((e) => e.level !== 'debug' || verbose);
    if (kept.length === 0) return;

    const area = sessionArea();
    if (area) {
      try {
        const stored = await area.get(STORAGE_KEY);
        const storedEntries = Array.isArray(stored?.[STORAGE_KEY])
          ? (stored[STORAGE_KEY] as DevLogEntry[])
          : [];
        // Drop debug lines persisted while verbose was off, so the panel does
        // not show scattered `debug` rows surviving from a short window.
        const base = verbose ? storedEntries : storedEntries.filter((e) => e.level !== 'debug');
        // Ours are newer by construction; keep them last, without re-adding
        // lines another context already persisted.
        const known = new Set(kept.map(entryKey));
        const merged = base.filter((e) => !known.has(entryKey(e)));
        entries = [...merged, ...kept].slice(-MAX_ENTRIES);
      } catch {
        entries = [...entries, ...kept].slice(-MAX_ENTRIES);
      }
    } else {
      entries = [...entries, ...kept].slice(-MAX_ENTRIES);
    }
    if (area) {
      try {
        await area.set({ [STORAGE_KEY]: entries });
      } catch {
        // Quota or a torn-down worker: keep the in-memory copy and move on.
      }
    }
    emitChange();
  });
  return writeChain;
}

function entryKey(e: DevLogEntry): string {
  return `${e.t}|${e.source}|${e.scope}|${e.message}`;
}

/**
 * Append an entry.
 *
 * Callers MUST pass redacted text: hostnames and status codes, never cookies,
 * tokens, request headers, or whole response bodies. The panel is meant to be
 * screenshotted into a bug report.
 *
 * Returns immediately — logging never blocks or fails the caller's flow.
 */
function record(level: DevLogLevel, scope: string, message: string, detail?: string): void {
  const source: DevLogEntry['source'] = typeof window === 'undefined' ? 'sw' : 'page';
  void appendAndPersist([{ t: Date.now(), level, scope, message, detail, source }]);
}

async function read(): Promise<DevLogEntry[]> {
  await load();
  return [...entries];
}

/**
 * Resolve once every queued append has been persisted.
 *
 * Exposed because appends are fire-and-forget — callers must not be made to
 * await a log write — which leaves two legitimate needs: a test asserting on
 * stored state, and a context that wants the buffer durable before it goes away.
 */
function flush(): Promise<void> {
  return writeChain;
}

async function clear(): Promise<void> {
  await load();
  entries = [];
  const area = sessionArea();
  if (!area) {
    emitChange();
    return;
  }
  try {
    await area.remove(STORAGE_KEY);
  } catch {
    // Advisory: the in-memory buffer is already cleared.
  }
  emitChange();
}

async function isVerbose(): Promise<boolean> {
  await load();
  return verbose;
}

async function setVerbose(value: boolean): Promise<void> {
  await load();
  verbose = value;
  const area = sessionArea();
  if (area) {
    // Mirror into `local` as well: `session` storage is dropped when the
    // browser closes, and it is also the area whose lifetime is tied to the
    // browser *process*, so a service worker restarted after eviction would
    // otherwise come back with verbose silently off and stop recording the very
    // detail the user just asked for. The mirror is a boolean — it carries no
    // log content and nothing else reads it.
    try {
      await area.set({ [VERBOSE_KEY]: value });
    } catch {
      // Advisory setting; losing it only costs debug lines.
    }
    try {
      await browserLocalArea()?.set({ [VERBOSE_KEY]: value });
    } catch {
      // Same: purely advisory.
    }
  }
  emitChange();
}

/**
 * Live updates. Fires for entries written by *any* context, so the dashboard
 * panel shows service-worker activity as it happens.
 */
function subscribe(listener: (entries: DevLogEntry[]) => void): () => void {
  listeners.add(listener);
  // Emit immediately from the in-process copy so a panel can render on the same
  // tick, then again once session storage has hydrated (and on every later
  // change, including writes from the service worker).
  listener([...entries]);
  void load().then(() => emitChange());
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== 'session' || !(STORAGE_KEY in changes)) return;
    const next = changes[STORAGE_KEY].newValue;
    entries = Array.isArray(next) ? (next as DevLogEntry[]) : [];
    emitChange();
  };
  const canObserve = typeof chrome !== 'undefined' && Boolean(chrome.storage?.onChanged);
  if (canObserve) chrome.storage.onChanged.addListener(onChanged);
  return () => {
    listeners.delete(listener);
    if (canObserve) chrome.storage.onChanged.removeListener(onChanged);
  };
}

/**
 * ISO 8601 in the *local* timezone, with the offset made explicit.
 *
 * The panel renders `toLocaleTimeString`, i.e. local time, but the copy action
 * used `toISOString()` — which is UTC. So a copied line read
 * `2026-09-10T23:57:10.474Z` for the entry the panel was showing as `07:57:10`,
 * and the user reasonably asked which one was right. Both were; they were simply
 * eight hours apart, which makes cross-referencing a pasted log against the panel
 * an exercise in arithmetic.
 *
 * The offset is kept because dropping it would make the timestamp ambiguous, and
 * the date is kept (unlike the panel, which shows only the time of day) because a
 * log spanning midnight is otherwise unreadable. Still ISO 8601, so it stays
 * parseable and sortable.
 */
export function toLocalIso(t: number): string {
  const d = new Date(t);
  const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');
  // `getTimezoneOffset` is minutes *behind* UTC (UTC+8 => -480), hence the negation.
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const stamp =
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${stamp}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export const devLog = {
  record,
  debug: (scope: string, message: string, detail?: string) => record('debug', scope, message, detail),
  info: (scope: string, message: string, detail?: string) => record('info', scope, message, detail),
  warn: (scope: string, message: string, detail?: string) => record('warn', scope, message, detail),
  error: (scope: string, message: string, detail?: string) => record('error', scope, message, detail),
  read,
  flush,
  clear,
  isVerbose,
  setVerbose,
  subscribe,

  /** Filter helper shared by the panel and its tests. */
  filter(
    list: DevLogEntry[],
    opts: { level?: DevLogLevel | 'all'; scope?: string; text?: string } = {},
  ): DevLogEntry[] {
    const min = opts.level && opts.level !== 'all' ? LEVEL_RANK[opts.level] : 0;
    const text = (opts.text || '').trim().toLowerCase();
    return list.filter((entry) => {
      if (LEVEL_RANK[entry.level] < min) return false;
      if (opts.scope && opts.scope !== 'all' && entry.scope !== opts.scope) return false;
      if (!text) return true;
      return `${entry.scope} ${entry.message} ${entry.detail || ''}`.toLowerCase().includes(text);
    });
  },

  /** Plain-text dump for the panel's copy action. */
  toText(list: DevLogEntry[]): string {
    return list
      .map((e) => {
        // Local time with an explicit offset, so a pasted line reads as the same
        // wall clock the panel showed. See `toLocalIso`.
        const time = toLocalIso(e.t);
        const detail = e.detail ? ` | ${e.detail}` : '';
        return `${time} [${e.level.toUpperCase()}] ${e.source} ${e.scope}: ${e.message}${detail}`;
      })
      .join('\n');
  },
};

/** Levels the panel offers, most severe first. */
export const DEV_LOG_LEVELS: DevLogLevel[] = ['error', 'warn', 'info', 'debug'];
