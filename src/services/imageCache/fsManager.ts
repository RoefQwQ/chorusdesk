/**
 * File System Access API Manager.
 * Handles user directory selection, IndexedDB handle persistence,
 * permission verification, and recursive directory navigation.
 */

const FS_DB_NAME = 'FeedHubFSCache';
const FS_STORE_NAME = 'handles';
const ROOT_HANDLE_KEY = 'root_cache_dir';

/**
 * Cached `indexedDB.open()` result for this session.
 *
 * The read path used to open the database on every call, then structured-clone
 * the stored `FileSystemDirectoryHandle` back out of it. That happened once per
 * media item per mounted card: a first screen of ~12 cards with ~2 images each
 * meant ~24 database opens and ~120 file probes before the feed settled, which
 * delayed every image that was still loading over the network. One connection
 * for the session removes the dominant cost.
 */
let handleDbPromise: Promise<IDBDatabase> | null = null;

/**
 * The root directory handle, memoized for the session. `null` means "looked up
 * and there is none" (or it was unbound) — distinct from "not looked up yet",
 * which is what the `undefined` initial value encodes.
 */
let rootHandleCache: FileSystemDirectoryHandle | null | undefined;

/**
 * Open or create the dedicated IndexedDB for FileSystemHandle persistence
 */
function openHandleDB(): Promise<IDBDatabase> {
  handleDbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(FS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(FS_STORE_NAME)) {
        db.createObjectStore(FS_STORE_NAME);
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // A version change or external close invalidates the cache, otherwise
      // every later transaction would throw on a closed connection.
      db.onclose = () => { handleDbPromise = null; };
      db.onversionchange = () => {
        db.close();
        handleDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      handleDbPromise = null;
      reject(request.error);
    };
  });
  return handleDbPromise;
}

/**
 * Save directory handle to IndexedDB
 */
export async function saveRootDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openHandleDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(FS_STORE_NAME);
    const req = store.put(handle, ROOT_HANDLE_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  rootHandleCache = handle;
}

/**
 * Get saved directory handle from IndexedDB, memoized for the session.
 *
 * Callers are hot: every media item on every mounted card asks. The memo turns
 * those into plain in-memory reads; the database is consulted at most once.
 */
export async function getSavedRootDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  if (rootHandleCache !== undefined) return rootHandleCache;
  try {
    const db = await openHandleDB();
    const handle = await new Promise<FileSystemDirectoryHandle | null>((resolve) => {
      const tx = db.transaction(FS_STORE_NAME, 'readonly');
      const store = tx.objectStore(FS_STORE_NAME);
      const req = store.get(ROOT_HANDLE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
    rootHandleCache = handle;
    return handle;
  } catch {
    // Do not memoize a failure: the next call may succeed (worker still warming
    // up, transient quota/version error).
    return null;
  }
}

/**
 * Clear the saved directory handle
 */
export async function clearRootDirectoryHandle(): Promise<void> {
  const db = await openHandleDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(FS_STORE_NAME, 'readwrite');
    const store = tx.objectStore(FS_STORE_NAME);
    const req = store.delete(ROOT_HANDLE_KEY);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
  // Memoized as "no directory bound", so the next read does not resurrect it.
  rootHandleCache = null;
}

/**
 * Verify whether we currently have read/write permission to the handle.
 * If not, attempts to request permission (must be triggered by a user gesture if prompt needed).
 */
export async function verifyDirectoryPermission(
  handle: FileSystemDirectoryHandle,
  readWrite: boolean = true
): Promise<boolean> {
  const options: { mode: 'read' | 'readwrite' } = { mode: readWrite ? 'readwrite' : 'read' };
  try {
    const directoryHandle = handle as FileSystemDirectoryHandle & {
      queryPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
      requestPermission?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    if ((await directoryHandle.queryPermission?.(options)) === 'granted') {
      return true;
    }
    if ((await directoryHandle.requestPermission?.(options)) === 'granted') {
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Interactively prompt user to select a root directory for image cache.
 */
export async function promptSelectDirectory(): Promise<FileSystemDirectoryHandle | null> {
  const picker = typeof window !== 'undefined'
    ? (window as unknown as Record<string, unknown>).showDirectoryPicker
    : undefined;
  if (typeof picker !== 'function') {
    throw new Error('当前浏览器环境不支持 File System Access API（showDirectoryPicker）。请确保在 Chrome 桌面端使用。');
  }

  try {
    const handle = await (picker as (opts: unknown) => Promise<FileSystemDirectoryHandle>)({
      id: 'creator-feed-hub-image-cache',
      mode: 'readwrite',
      startIn: 'pictures',
    });
    if (handle) {
      await saveRootDirectoryHandle(handle);
      return handle;
    }
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      return null; // User cancelled
    }
    throw err;
  }
  return null;
}

/**
 * Get or recursively create a nested directory under a root directory handle.
 * e.g. pathSegments = ['博主名', '小红书', '20240426_123456']
 */
export async function getOrCreateNestedDirectory(
  root: FileSystemDirectoryHandle,
  pathSegments: string[]
): Promise<FileSystemDirectoryHandle> {
  let currentDir = root;
  for (const segment of pathSegments) {
    if (!segment) continue;
    currentDir = await currentDir.getDirectoryHandle(segment, { create: true });
  }
  return currentDir;
}

/**
 * Try to get a nested directory without creating it.
 * Returns null if any segment in the path does not exist.
 */
export async function getExistingNestedDirectory(
  root: FileSystemDirectoryHandle,
  pathSegments: string[]
): Promise<FileSystemDirectoryHandle | null> {
  let currentDir = root;
  for (const segment of pathSegments) {
    if (!segment) continue;
    try {
      currentDir = await currentDir.getDirectoryHandle(segment, { create: false });
    } catch {
      return null;
    }
  }
  return currentDir;
}

/**
 * Save a Blob to a file inside a directory handle.
 */
export async function saveBlobToFile(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  blob: Blob
): Promise<void> {
  const fileHandle = await dir.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

/**
 * Read a file as Blob from a directory handle.
 * Returns null if the file does not exist.
 */
export async function readFileAsBlob(
  dir: FileSystemDirectoryHandle,
  fileName: string
): Promise<Blob | null> {
  try {
    const fileHandle = await dir.getFileHandle(fileName, { create: false });
    return await fileHandle.getFile();
  } catch {
    return null;
  }
}
