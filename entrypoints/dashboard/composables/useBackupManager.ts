import type { Ref } from 'vue';
import { backupService, downloadBackup, saveBackupToDisk, readBackupFile } from '../../../src/application';
import type { AppSettings } from '../../../src/types';

export interface BackupManagerDependencies {
  reloadData: () => Promise<void>;
  /** Live settings ref — refreshed with the settings returned by restore. */
  settings: Ref<AppSettings>;
}

/**
 * Dashboard backup lifecycle: JSON export (download or File System Access
 * save) and import/restore of a user-picked backup file. Delegates to
 * `backupService` / `backupFileService` — no database access in callers.
 * Messages and download filename match the legacy dashboard handlers.
 */
export function useBackupManager(deps: BackupManagerDependencies) {
  async function exportBackup() {
    const data = await backupService.export();
    downloadBackup(data);
  }

  async function exportBackupToFile() {
    const data = await backupService.export();
    const result = await saveBackupToDisk(data);
    if (result === 'saved') {
      alert('已成功将完整数据备份写入至你指定的本地文件！');
    }
    // 'aborted' (user cancelled) and 'downloaded' (fallback) need no extra
    // alert — the latter already produced a standard download.
  }

  async function handleImportFile(source: File | Event) {
    const file = source instanceof File
      ? source
      : (source.target as HTMLInputElement | null)?.files?.[0];
    if (!file) return;
    const parsed = await readBackupFile(file);
    if (!parsed.ok) {
      alert('备份文件无法读取：' + parsed.error);
      return;
    }
    try {
      deps.settings.value = await backupService.restore(parsed.data);
      await deps.reloadData();
      alert('备份恢复成功！创作者档案、各平台账号及历史动态已全部恢复。');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '未知错误';
      alert('备份文件无法读取：' + message);
    }
  }

  return { exportBackup, exportBackupToFile, handleImportFile };
}
