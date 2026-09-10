import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DevLogEntry } from '../src/utils/devLog';

/**
 * Developer-log behaviour.
 *
 * The panel is the only way to see service-worker activity in a packaged
 * extension, so two properties matter more than anything else: the ring is
 * actually bounded (a logging loop must not grow storage without limit), and a
 * concurrent writer in another context does not wipe the buffer.
 *
 * The module reads `chrome.storage.session` lazily on first use, so every test
 * installs a fresh fake and re-imports it.
 */

const ENTRIES_KEY = 'devLog.entries';

type ChangeListener = (changes: Record<string, unknown>, area: string) => void;

/** Minimal in-memory stand-in for `chrome.storage.session`. */
class FakeSessionArea {
  private data = new Map<string, unknown>();
  /** When set, `get` blocks on it — used to make hydration timing deterministic. */
  private gate: Promise<void> | null = null;
  private openGate: (() => void) | null = null;

  /** Hold every subsequent `get` until `releaseReads()`. */
  holdReads(): void {
    const { promise, resolve } = Promise.withResolvers<void>();
    this.gate = promise;
    this.openGate = resolve;
  }

  releaseReads(): void {
    this.openGate?.();
    this.gate = null;
    this.openGate = null;
  }

  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    if (this.gate) await this.gate;
    const wanted = Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const key of wanted) if (this.data.has(key)) out[key] = this.data.get(key);
    return out;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }

  /** Emulate another context (the service worker) appending to the same buffer. */
  async appendAsOtherContext(entry: DevLogEntry): Promise<void> {
    const stored = this.data.get(ENTRIES_KEY);
    const existing: DevLogEntry[] = Array.isArray(stored) ? stored as DevLogEntry[] : [];
    this.data.set(ENTRIES_KEY, [...existing, entry]);
  }

  /** Raw snapshot, so tests can assert on what is actually stored. */
  async snapshot(): Promise<DevLogEntry[]> {
    const stored = this.data.get(ENTRIES_KEY);
    // Boundary of a test double: the fake owns the untyped map entry.
    const typed: DevLogEntry[] = Array.isArray(stored) ? stored as DevLogEntry[] : [];
    return typed;
  }
}

let area: FakeSessionArea;
let localArea: FakeSessionArea;
let changeListeners: ChangeListener[];

function installChrome(storageAvailable = true) {
  area = new FakeSessionArea();
  localArea = new FakeSessionArea();
  changeListeners = [];
  if (!storageAvailable) {
    vi.stubGlobal('chrome', undefined);
    return;
  }
  vi.stubGlobal('chrome', {
    storage: {
      session: area,
      local: localArea,
      onChanged: {
        addListener: (fn: ChangeListener) => changeListeners.push(fn),
        removeListener: (fn: ChangeListener) => {
          changeListeners = changeListeners.filter((l) => l !== fn);
        },
      },
    },
  });
}

/** Fresh module instance so its lazy `loaded` flag starts false. */
async function freshDevLog() {
  vi.resetModules();
  return (await import('../src/utils/devLog')).devLog;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  installChrome();
});

describe('devLog ring buffer', () => {
  it('stores entries and reads them back oldest first', async () => {
    const log = await freshDevLog();
    log.info('sw', 'first');
    log.warn('router', 'second');
    await log.flush();

    const entries = await log.read();
    expect(entries.map((e) => e.message)).toEqual(['first', 'second']);
    expect(entries.map((e) => e.scope)).toEqual(['sw', 'router']);
    expect(entries.every((e) => e.source === 'sw')).toBe(true);
  });

  it('is bounded: it drops the oldest entries instead of growing without limit', async () => {
    const log = await freshDevLog();
    for (let i = 0; i < 400; i++) log.info('loop', `entry ${i}`);
    await log.flush();

    const entries = await log.read();
    expect(entries.length).toBe(150);
    // The newest survive; the earliest are the ones discarded.
    expect(entries[entries.length - 1].message).toBe('entry 399');
    expect(entries.some((e) => e.message === 'entry 0')).toBe(false);
    // Storage holds the same trimmed set, not the full 400.
    expect((await area.snapshot()).length).toBe(150);
  });

  it('keeps debug entries out unless verbose is on', async () => {
    const log = await freshDevLog();
    log.debug('bgFetch', 'noise');
    log.info('bgFetch', 'kept');
    await log.flush();
    expect((await log.read()).map((e) => e.message)).toEqual(['kept']);

    await log.setVerbose(true);
    log.debug('bgFetch', 'now recorded');
    await log.flush();
    expect((await log.read()).map((e) => e.message)).toEqual(['kept', 'now recorded']);
  });

  it('remembers the verbose flag for the session', async () => {
    const log = await freshDevLog();
    await log.setVerbose(true);
    expect(await log.isVerbose()).toBe(true);

    // A second context (fresh module state) reads the same session storage.
    const other = await freshDevLog();
    expect(await other.isVerbose()).toBe(true);
  });

  it('applies a verbose toggle made in another context to this one', async () => {
    // The panel is a page; the code that logs requests is in the service
    // worker. The switch therefore has to cross contexts through storage, not
    // through one context's module state — otherwise "详细模式" appears to do
    // nothing at all.
    const worker = await freshDevLog();
    worker.debug('bgFetch', 'before toggle');
    await worker.flush();
    expect(await worker.read()).toEqual([]);

    // The dashboard toggles verbose…
    const panel = await freshDevLog();
    await panel.setVerbose(true);

    // …and the worker (separate module state) records debug from then on.
    worker.debug('bgFetch', 'after toggle');
    await worker.flush();
    expect((await worker.read()).map((e) => e.message)).toEqual(['after toggle']);
  });

  it('survives a service-worker restart via the durable mirror', async () => {
    const panel = await freshDevLog();
    await panel.setVerbose(true);

    // A restarted worker hydrates from scratch (fresh module state, session
    // storage cleared by eviction) and must still honour the switch.
    await area.remove('devLog.verbose');
    const worker = await freshDevLog();
    expect(await worker.isVerbose()).toBe(true);

    worker.debug('bgFetch', 'recorded after restart');
    await worker.flush();
    expect((await worker.read()).map((e) => e.message)).toEqual(['recorded after restart']);
  });

  it('drops debug lines that were persisted while verbose was off', async () => {
    await area.appendAsOtherContext({
      t: 1, level: 'debug', scope: 'bgFetch', message: 'stale debug', source: 'sw',
    });
    await area.appendAsOtherContext({
      t: 2, level: 'info', scope: 'bgFetch', message: 'kept info', source: 'sw',
    });
    const log = await freshDevLog();

    log.info('sw', 'trigger a write');
    await log.flush();

    expect((await log.read()).map((e) => e.message)).toEqual(['kept info', 'trigger a write']);
  });

  it('clear empties the buffer and the stored copy', async () => {
    const log = await freshDevLog();
    log.error('sw', 'boom');
    await log.flush();
    expect((await log.read()).length).toBe(1);

    await log.clear();
    expect(await log.read()).toEqual([]);
    expect(await area.snapshot()).toEqual([]);
  });

  it('does not report an empty buffer when reads race the first hydration', async () => {
    // Seed storage as another context (the SW) would have.
    await area.appendAsOtherContext({
      t: 1, level: 'warn', scope: 'router', message: 'pre-existing', source: 'sw',
    });
    const log = await freshDevLog();
    area.holdReads();

    let settled = 0;
    const reads = [log.read(), log.read(), log.read()].map((p) =>
      p.then((value) => { settled += 1; return value; }),
    );

    // Hydration is blocked, so nothing may have resolved. A per-call `loaded`
    // flag would let the later reads return the (still empty) buffer here.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(settled).toBe(0);

    area.releaseReads();
    for (const result of await Promise.all(reads)) {
      expect(result.map((e) => e.message)).toEqual(['pre-existing']);
    }
  });
});

describe('devLog without chrome.storage', () => {
  it('keeps working in memory', async () => {
    installChrome(false);
    const log = await freshDevLog();

    log.error('sw', 'no chrome here');
    await log.flush();

    expect((await log.read()).map((e) => e.message)).toEqual(['no chrome here']);
  });
});

describe('cross-context visibility', () => {
  it('does not drop entries another context persisted', async () => {
    const log = await freshDevLog();
    log.info('sw', 'from worker');
    await log.flush();

    // The dashboard appends while the SW holds its own in-memory copy.
    await area.appendAsOtherContext({
      t: Date.now(), level: 'info', scope: 'page', message: 'from dashboard', source: 'page',
    });

    log.info('sw', 'after');
    await log.flush();

    const messages = (await log.read()).map((e) => e.message);
    expect(messages).toContain('from worker');
    expect(messages).toContain('from dashboard');
    expect(messages).toContain('after');
  });

  it('notifies subscribers when another context writes', async () => {
    const log = await freshDevLog();
    const seen: string[][] = [];
    const unsubscribe = log.subscribe((entries) => seen.push(entries.map((e) => e.message)));
    await log.read();

    const next: DevLogEntry[] = [
      { t: Date.now(), level: 'warn', scope: 'router', message: 'refused', source: 'sw' },
    ];
    for (const listener of changeListeners) {
      listener({ [ENTRIES_KEY]: { newValue: next } }, 'session');
    }

    expect(seen[seen.length - 1]).toEqual(['refused']);
    unsubscribe();
  });

  it('ignores writes to other storage areas', async () => {
    const log = await freshDevLog();
    const seen: string[][] = [];
    log.subscribe((entries) => seen.push(entries.map((e) => e.message)));
    await log.read();

    const localWrite: DevLogEntry[] = [
      { t: 1, level: 'info', scope: 'x', message: 'from local', source: 'page' },
    ];
    for (const listener of changeListeners) {
      listener({ [ENTRIES_KEY]: { newValue: localWrite } }, 'local');
    }

    expect(seen[seen.length - 1]).toEqual([]);
  });
});

describe('filtering and export', () => {
  const entries: DevLogEntry[] = [
    { t: 1, level: 'debug', scope: 'bgFetch', message: 'GET ok', source: 'sw' },
    { t: 2, level: 'info', scope: 'channelSync', message: 'weibo ok', source: 'sw' },
    { t: 3, level: 'warn', scope: 'channelSync', message: 'weibo failed', detail: 'code=auth', source: 'page' },
    { t: 4, level: 'error', scope: 'router', message: 'refused', source: 'sw' },
  ];

  it('treats the level filter as a minimum severity', async () => {
    const log = await freshDevLog();
    expect(log.filter(entries, { level: 'warn' }).map((e) => e.message)).toEqual([
      'weibo failed', 'refused',
    ]);
    expect(log.filter(entries, { level: 'all' })).toHaveLength(4);
  });

  it('filters by scope and free text across message and detail', async () => {
    const log = await freshDevLog();
    expect(log.filter(entries, { scope: 'channelSync' }).map((e) => e.message)).toEqual([
      'weibo ok', 'weibo failed',
    ]);
    // Matches `detail`, which is where error codes live.
    expect(log.filter(entries, { text: 'code=auth' }).map((e) => e.message)).toEqual(['weibo failed']);
    expect(log.filter(entries, { text: 'NOTHING' })).toEqual([]);
  });

  it('exports a copyable text block', async () => {
    const log = await freshDevLog();
    const text = log.toText(entries);
    expect(text.split('\n')).toHaveLength(4);
    expect(text).toContain('[WARN] page channelSync: weibo failed | code=auth');
  });
});
