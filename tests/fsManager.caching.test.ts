import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Session caching in the File System Access handle store.
 *
 * The read path is hot: every media item on every mounted card asks for the root
 * directory handle. It used to call `indexedDB.open()` and re-deserialize the
 * stored `FileSystemDirectoryHandle` on each call — a first screen of ~12 cards
 * with ~2 images each meant ~24 database opens plus an extension-probe ladder per
 * image before the feed settled. On a real profile that showed up as images
 * sitting blank for several seconds.
 *
 * These tests pin the two properties that fix depends on: the database is opened
 * once per session, and the handle is read from it once per session.
 */

/** Counts `indexedDB.open` calls and serves a fake database. */
const idb = vi.hoisted(() => {
  const state = {
    openCalls: 0,
    /** Value the fake store returns for the root-handle key. */
    stored: null as unknown,
    /** When true, the store's `get` reports a failure. */
  };
  return state;
});

class FakeRequest<T> {
  onsuccess: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onupgradeneeded: (() => void) | null = null;
  result!: T;
  error: unknown = null;
}

interface FakeDatabase {
  objectStoreNames: { contains: () => boolean };
  transaction: () => { objectStore: () => unknown };
  close: () => void;
  onclose: null;
  onversionchange: null;
}

function fakeDatabase(): FakeDatabase {
  const store = {
    get: () => {
      const req = new FakeRequest<unknown>();
      req.result = idb.stored;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
    put: () => {
      const req = new FakeRequest<void>();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
    delete: () => {
      const req = new FakeRequest<void>();
      idb.stored = null;
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  };
  return {
    objectStoreNames: { contains: () => true },
    transaction: () => ({ objectStore: () => store }),
    close: () => {},
    onclose: null,
    onversionchange: null,
  };
}

beforeEach(() => {
  idb.openCalls = 0;
  idb.stored = null;
  vi.resetModules();
  vi.stubGlobal('indexedDB', {
    open: () => {
      idb.openCalls++;
      const req = new FakeRequest<FakeDatabase>();
      req.result = fakeDatabase();
      queueMicrotask(() => req.onsuccess?.());
      return req;
    },
  });
});

async function freshFsManager() {
  return import('../src/services/imageCache/fsManager');
}

/** The fake handle the store hands back. */
const HANDLE = { name: 'ChorusCache', kind: 'directory' };

describe('root handle caching', () => {
  it('opens the database once across repeated reads', async () => {
    idb.stored = HANDLE;
    const { getSavedRootDirectoryHandle } = await freshFsManager();

    await getSavedRootDirectoryHandle();
    await getSavedRootDirectoryHandle();
    await getSavedRootDirectoryHandle();

    expect(idb.openCalls).toBe(1);
  });

  it('reads the stored handle once and reuses it', async () => {
    idb.stored = HANDLE;
    const { getSavedRootDirectoryHandle } = await freshFsManager();

    const first = await getSavedRootDirectoryHandle();
    // Change what the store would return: a cached read must not see it.
    idb.stored = { name: 'OtherDirectory', kind: 'directory' };
    const second = await getSavedRootDirectoryHandle();

    expect(first).toBe(HANDLE);
    expect(second).toBe(HANDLE);
  });

  it('memoizes "no directory bound" instead of re-opening every time', async () => {
    idb.stored = null;
    const { getSavedRootDirectoryHandle } = await freshFsManager();

    expect(await getSavedRootDirectoryHandle()).toBeNull();
    expect(await getSavedRootDirectoryHandle()).toBeNull();
    expect(idb.openCalls).toBe(1);
  });

  it('serves the newly saved handle without another read', async () => {
    idb.stored = null;
    const { getSavedRootDirectoryHandle, saveRootDirectoryHandle } = await freshFsManager();
    expect(await getSavedRootDirectoryHandle()).toBeNull();

    await saveRootDirectoryHandle(HANDLE as never);

    expect(await getSavedRootDirectoryHandle()).toBe(HANDLE);
  });

  it('forgets the handle after unbinding', async () => {
    idb.stored = HANDLE;
    const { getSavedRootDirectoryHandle, clearRootDirectoryHandle } = await freshFsManager();
    expect(await getSavedRootDirectoryHandle()).toBe(HANDLE);

    await clearRootDirectoryHandle();

    // Explicitly unbound: the memo must not resurrect the old directory.
    expect(await getSavedRootDirectoryHandle()).toBeNull();
  });
});
