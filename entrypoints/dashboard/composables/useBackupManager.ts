import type { Ref } from 'vue';
import { backupService, downloadBackup, saveBackupToDisk, readBackupFile } from '../../../src/application';
import { dialog } from './useDialog';
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
      await dialog.alert('已成功将完整数据备份写入至你指定的本地文件！');
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
      await dialog.alert('备份文件无法读取：' + parsed.error);
      return;
    }
    // P0-5: the same button used to do an overlay import while the messages
    // called it a restore ("已全部恢复"), so a file with fewer records than the
    // library silently kept the extras. Ask which one is meant.
    //
    // A file exported before format 1.1 carries no 删除黑名单, so a replace
    // restore of one leaves every previously-deleted post able to come back.
    // Said here rather than swallowed: it is the one consequence of the choice
    // the user cannot see afterwards.
    const olderFormat = parsed.data.suppressions === undefined;
    const replace = await dialog.confirm(
      '要如何导入这份备份？\n\n' +
      '【确定】恢复快照：清空当前数据，还原为备份里的状态（适合重装 / 换设备）。\n' +
      '【取消】合并导入：保留当前数据，同 ID 的记录用备份覆盖（适合并入一份备份）。' +
      (olderFormat
        ? '\n\n注意：这份备份是旧格式，不含已删除动态的记录；恢复快照会同时清空当前的删除记录，曾被删除的动态可能重新出现。'
        : ''),
    );
    try {
      deps.settings.value = await backupService.restore(parsed.data, replace ? 'replace' : 'merge');
      await deps.reloadData();
      await dialog.alert(replace
        ? '已恢复为备份快照：当前数据已清空并还原为备份中的状态。'
        : '已合并导入：当前数据保留，同 ID 记录已用备份覆盖。');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : '未知错误';
      await dialog.alert('备份文件无法读取：' + message);
    }
  }

  return { exportBackup, exportBackupToFile, handleImportFile };
}
