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

/** Current backup format version this build reads and writes. */
export const CURRENT_BACKUP_VERSION = '1.0';

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

/** Max invalid records listed in one error message before truncating. */
const MAX_REPORTED_INVALID = 5;

interface RecordRequirements {
  store: keyof RestorableBackup;
  /** Required identity/relation fields per record of this store. */
  requiredFields: readonly string[];
}

const RECORD_REQUIREMENTS: readonly RecordRequirements[] = [
  { store: 'creators', requiredFields: ['id', 'name'] },
  { store: 'channels', requiredFields: ['id', 'creatorId', 'platform', 'accountId'] },
  { store: 'posts', requiredFields: ['id', 'channelId', 'platform', 'publishedAt'] },
];

/**
 * Validate one store's records against its required fields. Returns up to
 * `MAX_REPORTED_INVALID` "store[index]: missing field" reasons.
 */
function collectInvalidRecords(
  store: keyof RestorableBackup,
  records: unknown[],
  requiredFields: readonly string[],
): string[] {
  const problems: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (typeof record !== 'object' || record === null) {
      problems.push(`${store}[${i}]: 不是对象`);
    } else {
      const missing = requiredFields.filter(
        (field) =>
          !((record as Record<string, unknown>)[field] !== undefined &&
            (record as Record<string, unknown>)[field] !== null &&
            String((record as Record<string, unknown>)[field]) !== ''),
      );
      if (missing.length > 0) {
        problems.push(`${store}[${i}]: 缺少字段 ${missing.join(', ')}`);
      }
    }
    if (problems.length >= MAX_REPORTED_INVALID) break;
  }
  return problems;
}

/**
 * Snapshot the whole library for export. Matches the legacy dashboard
 * exporter exactly (arrays read in PK order, settings merged with defaults).
 */
export async function createBackup(): Promise<FeedBackup> {
  return {
    version: CURRENT_BACKUP_VERSION,
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
 * Accepts the same partial shapes the old importer tolerated — but only when
 * the values are actually arrays / an object, the top-level `version` matches
 * this build's format, and every record carries its required identity fields.
 * Fails fast: a file with invalid rows is rejected wholesale, never partially
 * imported.
 */
export function parseBackup(raw: unknown): BackupParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '备份格式无效：文件内容不是 JSON 对象' };
  }
  const data = raw as Record<string, unknown>;

  // Version gate: `version` was previously never inspected, so a truncated,
  // foreign or future-format file could be imported as garbage rows.
  if (data.version === undefined) {
    return { ok: false, error: '备份格式无效：缺少 version 字段（可能不是本扩展导出的备份）' };
  }
  if (data.version !== CURRENT_BACKUP_VERSION) {
    return {
      ok: false,
      error: `备份版本不兼容：文件为 ${String(data.version)}，本扩展支持 ${CURRENT_BACKUP_VERSION}`,
    };
  }

  for (const store of ['creators', 'channels', 'posts'] as const) {
    if (data[store] !== undefined && !Array.isArray(data[store])) {
      return { ok: false, error: `备份格式无效：${store} 应为数组` };
    }
  }
  if (data.settings !== undefined && (typeof data.settings !== 'object' || data.settings === null || Array.isArray(data.settings))) {
    return { ok: false, error: '备份格式无效：settings 应为对象' };
  }

  const invalid: string[] = [];
  for (const { store, requiredFields } of RECORD_REQUIREMENTS) {
    const records = data[store];
    if (Array.isArray(records)) {
      invalid.push(...collectInvalidRecords(store, records, requiredFields));
      if (invalid.length >= MAX_REPORTED_INVALID) break;
    }
  }
  if (invalid.length > 0) {
    const more = invalid.length >= MAX_REPORTED_INVALID ? '（仅列出前 5 条）' : '';
    return { ok: false, error: `备份内容校验失败：\n${invalid.join('\n')}${more}` };
  }

  return {
    ok: true,
    data: {
      creators: data.creators as Creator[] | undefined,
      channels: data.channels as Channel[] | undefined,
      settings: data.settings as Partial<AppSettings> | undefined,
      posts: data.posts as Post[] | undefined,
    },
  };
}
