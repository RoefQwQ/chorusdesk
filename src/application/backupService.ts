import {
  createBackup,
  restoreBackup,
  type FeedBackup,
  type RestorableBackup,
} from '../infrastructure/db/backupRepository';
import { getSettings } from '../infrastructure/db/settingsRepository';
import type { AppSettings } from '../types';

/** How an imported file meets the existing library (P0-5). */
export type RestoreMode =
  /** 恢复快照: wipe the library, then write the file — "the state I exported". */
  | 'replace'
  /** 合并导入: keep what is here, overwrite same-id rows — "add this on top". */
  | 'merge';

/**
 * Backup lifecycle service. `restore` returns the settings that are in
 * effect after the import (backup settings merged over defaults) so callers
 * can refresh their in-memory settings state.
 *
 * `mode` makes the two things the old single `restore` conflated explicit:
 * the file is a SNAPSHOT, so restoring it should mean the library becomes the
 * file (DELETION_MODEL §7 ⑤ / audit P0-5). `'merge'` preserves the old
 * overlay behavior for callers that want to add a file to what is there.
 */
export const backupService = {
  async export(): Promise<FeedBackup> {
    return createBackup();
  },

  async restore(data: RestorableBackup, mode: RestoreMode = 'replace'): Promise<AppSettings> {
    // One transaction either way: the wipe and the write must not be observable
    // apart, or a failure between them leaves the library empty.
    await restoreBackup(data, { clearFirst: mode === 'replace' });
    return getSettings();
  },
};
