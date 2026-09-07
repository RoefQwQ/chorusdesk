import { createBackup, restoreBackup, type FeedBackup, type RestorableBackup } from '../infrastructure/db/backupRepository';
import { getSettings } from '../infrastructure/db/settingsRepository';
import type { AppSettings } from '../types';

/**
 * Backup lifecycle service. `restore` returns the settings that are in
 * effect after the import (backup settings merged over defaults) so callers
 * can refresh their in-memory settings state.
 */
export const backupService = {
  async export(): Promise<FeedBackup> {
    return createBackup();
  },

  async restore(data: RestorableBackup): Promise<AppSettings> {
    await restoreBackup(data);
    return getSettings();
  },
};
