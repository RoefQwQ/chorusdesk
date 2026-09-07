import type { AppSettings, Channel, Creator, Post } from '../../types';
import { db } from './database';
import { getSettings, saveSettings } from './settingsRepository';

/**
 * Backup file format — DO NOT CHANGE. The JSON layout, `version: '1.0'`
 * marker and `exportedAt` field are written/read by the existing dashboard
 * export/import flow and must stay byte-compatible with previously exported
 * backups.
 */
export interface FeedBackup {
  version: '1.0';
  exportedAt: string;
  creators: Creator[];
  channels: Channel[];
  settings: AppSettings;
  posts: Post[];
}

/**
 * Shape accepted on restore — every data section is optional so that files
 * missing a section (older/partial backups) import cleanly, exactly like the
 * legacy importer's per-section guards.
 */
export interface RestorableBackup {
  creators?: Creator[];
  channels?: Channel[];
  settings?: Partial<AppSettings>;
  posts?: Post[];
}

export type BackupParseResult =
  | { ok: true; data: RestorableBackup }
  | { ok: false; error: string };

/**
 * Snapshot the whole library for export. Matches the legacy dashboard
 * exporter exactly (arrays read in PK order, settings merged with defaults).
 */
export async function createBackup(): Promise<FeedBackup> {
  return {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    creators: await db.creators.toArray(),
    channels: await db.channels.toArray(),
    settings: await getSettings(),
    posts: await db.posts.toArray(),
  };
}

/**
 * Restore a previously parsed backup into the database inside one
 * transaction, overwriting existing keys (bulkPut semantics). Only arrays
 * that are present in the file are touched; a missing `settings` object is
 * left as-is. Tombstone records are never part of a backup (legacy format).
 */
export async function restoreBackup(data: RestorableBackup): Promise<void> {
  await db.transaction('rw', [db.creators, db.channels, db.posts, db.settings], async () => {
    if (Array.isArray(data.creators)) await db.creators.bulkPut(data.creators);
    if (Array.isArray(data.channels)) await db.channels.bulkPut(data.channels);
    if (Array.isArray(data.posts)) await db.posts.bulkPut(data.posts);
    if (data.settings && typeof data.settings === 'object') await saveSettings(data.settings);
  });
}

/**
 * Validate an unknown parsed JSON payload against the backup format. Unlike
 * the legacy import (which used type assertions and let Dexie throw), this
 * returns a structured error so the UI can show a user-facing message.
 * Accepts the same partial shapes the old importer tolerated, but only when
 * the values are actually arrays / an object.
 */
export function parseBackup(raw: unknown): BackupParseResult {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: '备份格式无效' };
  }
  const data = raw as Record<string, unknown>;
  if (data.creators !== undefined && !Array.isArray(data.creators)) {
    return { ok: false, error: '备份格式无效' };
  }
  if (data.channels !== undefined && !Array.isArray(data.channels)) {
    return { ok: false, error: '备份格式无效' };
  }
  if (data.posts !== undefined && !Array.isArray(data.posts)) {
    return { ok: false, error: '备份格式无效' };
  }
  if (data.settings !== undefined && (typeof data.settings !== 'object' || data.settings === null)) {
    return { ok: false, error: '备份格式无效' };
  }
  return { ok: true, data: data as unknown as RestorableBackup };
}
