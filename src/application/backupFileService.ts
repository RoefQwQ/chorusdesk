import {
  parseBackup,
  type BackupParseResult,
  type FeedBackup,
} from '../infrastructure/db/backupRepository';

const BACKUP_FILE_PREFIX = 'creator-feed-hub-backup';

interface BackupFileSystemHandle {
  createWritable(): Promise<{ write(content: string): Promise<void>; close(): Promise<void> }>;
}

function backupFileName(): string {
  return `${BACKUP_FILE_PREFIX}-${new Date().toISOString().slice(0, 10)}.json`;
}

/**
 * Trigger a standard browser download of the backup JSON (Blob + object URL).
 * Format and filename match the legacy dashboard exporter exactly.
 */
export function downloadBackup(data: FeedBackup): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = backupFileName();
  a.click();
  URL.revokeObjectURL(url);
}

export type SaveBackupResult = 'saved' | 'downloaded' | 'aborted';

/**
 * Persist the backup via the File System Access API when supported (lets the
 * user pick a target directory/file), otherwise fall back to a standard
 * download. `'aborted'` means the user cancelled the save picker.
 */
export async function saveBackupToDisk(data: FeedBackup): Promise<SaveBackupResult> {
  const jsonStr = JSON.stringify(data, null, 2);

  if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
    try {
      const handle = await (window as Window & { showSaveFilePicker(options?: unknown): Promise<BackupFileSystemHandle> })
        .showSaveFilePicker({
          suggestedName: backupFileName(),
          types: [
            {
              description: 'JSON Backup File',
              accept: { 'application/json': ['.json'] },
            },
          ],
        });
      const writable = await handle.createWritable();
      await writable.write(jsonStr);
      await writable.close();
      return 'saved';
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return 'aborted';
      console.warn('showSaveFilePicker error:', e);
    }
  }

  downloadBackup(data);
  return 'downloaded';
}

/**
 * Read a user-picked backup file and validate it against the backup format.
 * Resolution never rejects — format problems come back as `{ ok: false }`.
 */
export function readBackupFile(file: File): Promise<BackupParseResult> {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = (e) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(e.target?.result || ''));
      } catch {
        resolve({ ok: false, error: '文件不是合法 JSON' });
        return;
      }
      resolve(parseBackup(parsed));
    };
    reader.onerror = () => resolve({ ok: false, error: '读取文件失败' });
    reader.readAsText(file);
  });
}
