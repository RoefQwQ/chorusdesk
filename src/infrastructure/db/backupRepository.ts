import type { AppSettings, Channel, Creator, Post, PostSuppression } from '../../types';
import { toEpochMs } from '../../utils/timestamp';
import { db } from './database';
import { getSettings, saveSettings } from './settingsRepository';

/**
 * Backup file format.
 *
 * 1.0 → 1.1 (2026-09-12, AUDIT §6 方案 A): adds `suppressions`, the record of
 * what the user explicitly deleted. Without it a backup carried whom I follow,
 * what I saved and what I read — but not 「不要再给我看」, so import + sync
 * resurrected deleted posts. Both versions are accepted; the version gate
 * (`parseBackup`) is an explicit allowlist, not an equality check.
 *
 * `version` and `exportedAt` are read/written by the dashboard export/import
 * flow and stay compatible with previously exported files.
 */
export interface FeedBackup {
  version: '1.1';
  exportedAt: string;
  creators: Creator[];
  channels: Channel[];
  settings: AppSettings;
  posts: Post[];
  /** The deletion blacklist. Absent in 1.0 files (imported as empty). */
  suppressions: PostSuppression[];
}

/** Format versions this build can read. */
export const SUPPORTED_BACKUP_VERSIONS = ['1.0', '1.1'] as const;

/** Current backup format version this build reads and writes. */
export const CURRENT_BACKUP_VERSION = '1.1';

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
  suppressions?: PostSuppression[];
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
  { store: 'suppressions', requiredFields: ['postId', 'platform', 'suppressedAt'] },
];

/**
 * Validate one store's records: required fields, then the field-type rules.
 * Returns up to `MAX_REPORTED_INVALID` reasons, each naming its field.
 *
 * The two halves are one pass over one list of records on purpose. As two
 * functions gated on `invalid.length === 0`, every guard and every loop-exit in
 * the second was a branch the suite could only reach with a contrived file —
 * `npm run test:coverage`'s ratchet then measured the guard syntax rather than
 * the validation. Here the `MAX_REPORTED_INVALID` cap is written once, so
 * "truncate the message list" has a single line to cover instead of five.
 */
function collectRecordProblems(store: keyof RestorableBackup, records: unknown[]): string[] {
  const rules = RECORD_REQUIREMENTS.find((r) => r.store === store)!.requiredFields;
  const problems: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!isPlainObject(record)) {
      problems.push(`${store}[${i}]: 不是对象`);
    } else {
      const missing = rules.filter(
        (field) => record[field] === undefined || record[field] === null || String(record[field]) === '',
      );
      if (missing.length > 0) problems.push(`${store}[${i}]: 缺少字段 ${missing.join(', ')}`);
      problems.push(...recordFieldProblems(store, i, record));
    }
    if (problems.length >= MAX_REPORTED_INVALID) break;
  }
  return problems.slice(0, MAX_REPORTED_INVALID);
}

/* ── Field-level validation ──────────────────────────────────────────────
 *
 * The required-fields pass above answers "is this record recognisably itself".
 * These answer the question the database cares about instead: could this record
 * be WRITTEN without corrupting it. Only fields that are PRESENT are checked,
 * so files written before a field existed keep importing.
 *
 * Both halves are needed because a backup is the only path into IndexedDB that
 * bypasses every repository: `bulkPut` performs no validation whatsoever, so
 * whatever shape the file has is the shape the tables end up with.
 */

/** Values `settings.theme` may take (mirrors `AppSettings.theme`). */
const THEME_VALUES: readonly string[] = ['light', 'dark', 'system'];

/** Values `Channel.status` may take (mirrors the union in `types/index.ts`). */
const CHANNEL_STATUSES: readonly string[] = ['idle', 'updating', 'success', 'error'];

/** Values `imageCacheStrategy` may take. */
const IMAGE_CACHE_STRATEGIES: readonly string[] = ['all', 'restricted_only', 'bookmarks_only'];

/** Values `nameSource` / `accountRole` may take. */
const NAME_SOURCES: readonly string[] = ['generated', 'platform', 'user'];
const ACCOUNT_ROLES: readonly string[] = ['main', 'sub', 'alt', 'custom'];

/**
 * Sanity bounds for the two numeric settings.
 *
 * Deliberately NOT the option lists the settings UI offers (`5/10/20` and
 * `300/600/1200`): those are how the value is *chosen*, not what it may *be*.
 * The machine gate seeds `itemsPerFetch: 25` and round-trips it through this
 * validator, and a stored value is a number a past or future build accepted —
 * pinning today's three options would reject a file this very build exported
 * after a settings change. A range is what "no UI could have produced this"
 * actually means.
 */
const ITEMS_PER_FETCH_RANGE = { min: 1, max: 200 } as const;
const REQUEST_DELAY_MS_RANGE = { min: 0, max: 60_000 } as const;

/** ECMAScript's maximum `Date` value, in ms. Beyond it `new Date(x)` is Invalid. */
const MAX_TIMESTAMP_MS = 8.64e15;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `"store[i].field: reason"`, the one format every problem is reported in. */
function at(store: string, index: number, field: string, reason: string): string {
  return `${store}[${index}].${field}: ${reason}`;
}

/**
 * A stored timestamp must be a finite positive number that `Date` can hold.
 *
 * The resolution is NOT pinned: `Post.publishedAt` documents ms but several
 * adapters emit seconds, so a stored value is seconds-or-ms by design and
 * `utils/timestamp.ts` exists to normalize it at read time. Range-gating it as
 * ms would reject real bilibili rows; `toEpochMs` is the single source of that
 * threshold, so this reuses it rather than declaring a second one.
 */
function timestampProblem(value: unknown): string | null {
  if (typeof value !== 'number') return `不是数字（${typeof value}）`;
  if (toEpochMs(value) === null) return '不是有效的正数时间戳';
  if (value > MAX_TIMESTAMP_MS) return '超出 Date 可表示范围';
  return null;
}

/**
 * `0 | 1` flags. A boolean here is the specific corruption AGENTS rule 5
 * describes: IndexedDB refuses booleans as index keys, so such a row is never
 * entered into the index and every `.equals()` query silently misses it —
 * the unread badge and the bookmark stat both read 0 forever.
 */
function indexedFlagProblem(value: unknown): string | null {
  if (value === 0 || value === 1) return null;
  return value === true || value === false
    ? `必须是 0 或 1，收到布尔值 ${String(value)}（布尔不能作索引键，规则 5）`
    : `必须是 0 或 1，收到 ${JSON.stringify(value)}`;
}

function enumProblem(value: unknown, allowed: readonly string[]): string | null {
  return typeof value === 'string' && allowed.includes(value)
    ? null
    : `必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`;
}

/**
 * Field rules, as data.
 *
 * A table rather than one `if` per field because the shape is genuinely "the
 * same rule applies to N named fields" — and because the per-field form makes
 * every check contribute an uncoverable branch (the "field absent" arm, which
 * by definition the happy path never takes). One loop leaves a single absent
 * branch for the whole table, so `npm run test:coverage`'s ratchet measures the
 * rules rather than the syntax they were written in.
 */
type FieldRule = (value: unknown) => string | null;

const RULES: Record<string, readonly { field: string; rule: FieldRule }[]> = {
  creators: [
    { field: 'createdAt', rule: timestampProblem },
    { field: 'updatedAt', rule: timestampProblem },
    { field: 'nameSource', rule: v => enumProblem(v, NAME_SOURCES) },
    { field: 'tags', rule: v => (Array.isArray(v) ? null : '必须是数组') },
  ],
  channels: [
    { field: 'status', rule: v => enumProblem(v, CHANNEL_STATUSES) },
    { field: 'accountRole', rule: v => enumProblem(v, ACCOUNT_ROLES) },
    { field: 'nameSource', rule: v => enumProblem(v, NAME_SOURCES) },
    { field: 'lastCheckAt', rule: timestampProblem },
    { field: 'lastSuccessAt', rule: timestampProblem },
  ],
  posts: [
    { field: 'publishedAt', rule: timestampProblem },
    { field: 'fetchedAt', rule: timestampProblem },
    // The indexed flags. Checked including the optional `isBookmarked`: a file
    // that carries it with a boolean is exactly the unread-badge failure.
    { field: 'isRead', rule: indexedFlagProblem },
    { field: 'isBookmarked', rule: indexedFlagProblem },
    { field: 'mediaList', rule: v => (Array.isArray(v) ? null : '必须是数组') },
  ],
  suppressions: [
    { field: 'suppressedAt', rule: timestampProblem },
    // Attribution only, and documented as allowed to drift / to point at a
    // channel that no longer exists — so the type is checked, the reference is
    // not (see `collectRelationProblems`).
    { field: 'channelId', rule: v => (typeof v === 'string' ? null : `必须是字符串，收到 ${typeof v}`) },
    { field: 'creatorId', rule: v => (typeof v === 'string' ? null : `必须是字符串，收到 ${typeof v}`) },
  ],
};

/** Rules that apply to every store. */
const COMMON_RULES: readonly { field: string; rule: FieldRule }[] = [
  // Type only, NOT membership in `KNOWN_PLATFORMS`. The `Platform` type is
  // deliberately `KnownPlatform | (string & {})` — "plus legacy/stored values we
  // no longer ship" — and platforms have been removed (Rplay, Withny 2026-09),
  // so an enum here would make every backup taken before a removal
  // unimportable. An unknown platform is not corruption: `getAdapter` returns
  // undefined and the channel reports 「不支持的平台」
  // (`tests/channelSync.unsupported.test.ts`). Rejecting the file would destroy
  // more than it protects.
  { field: 'platform', rule: v => (typeof v === 'string' && v !== '' ? null : `必须是平台名（字符串），收到 ${JSON.stringify(v)}`) },
];

/**
 * Check one record's PRESENT fields. Absent fields are skipped, so files
 * written before a field existed keep importing.
 */
function recordFieldProblems(store: string, index: number, record: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const { field, rule } of [...COMMON_RULES, ...(RULES[store] ?? [])]) {
    if (record[field] === undefined) continue;
    const reason = rule(record[field]);
    if (reason !== null) problems.push(at(store, index, field, reason));
  }
  return problems;
}

/** Settings bounds for one number field. */
function numberRangeProblem(value: unknown, range: { min: number; max: number }): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return `必须是数字，收到 ${JSON.stringify(value)}`;
  if (value < range.min || value > range.max) return `超出 ${range.min}–${range.max} 范围，收到 ${value}`;
  return null;
}

/**
 * Validate the settings section. Only keys the file actually carries are
 * checked — the stored object is a partial merged over `DEFAULT_SETTINGS`, so
 * an absent key is normal, and unknown keys are not enumerated here (a
 * forward-written key must not make a file unimportable).
 */
function collectSettingsProblems(settings: unknown): string[] {
  if (!isPlainObject(settings)) return [];
  const problems: string[] = [];
  const check = (field: string, reason: string | null) => {
    if (reason !== null) problems.push(at('settings', 0, field, reason));
  };
  const present = (field: string) => settings[field] !== undefined;

  if (present('theme')) check('theme', enumProblem(settings.theme, THEME_VALUES));
  if (present('imageCacheStrategy')) {
    check('imageCacheStrategy', enumProblem(settings.imageCacheStrategy, IMAGE_CACHE_STRATEGIES));
  }
  if (present('itemsPerFetch')) check('itemsPerFetch', numberRangeProblem(settings.itemsPerFetch, ITEMS_PER_FETCH_RANGE));
  if (present('requestDelayMs')) check('requestDelayMs', numberRangeProblem(settings.requestDelayMs, REQUEST_DELAY_MS_RANGE));
  for (const field of ['autoOpenOriginalUrl', 'enableAutoSync', 'hideReposts', 'hideTextOnly', 'enableImageCache'] as const) {
    if (present(field) && typeof settings[field] !== 'boolean') {
      check(field, `必须是布尔值，收到 ${typeof settings[field]}`);
    }
  }
  if (present('platformOrder') && !Array.isArray(settings.platformOrder)) {
    check('platformOrder', '必须是数组');
  }
  return problems;
}

/* ── Relation validation ─────────────────────────────────────────────────
 *
 * Duplicate ids and dangling references are the two shapes that survive every
 * per-record check and still corrupt the library: `bulkPut` would collapse two
 * rows into one, or write a post whose channel does not exist (an orphan card
 * that no sync can repair, because sync is per-channel).
 *
 * A reference is only checked when the table it points at is PRESENT in the
 * file. A partial backup that carries posts but no channels is the documented
 * partial shape, not a broken file, so the check is skipped rather than
 * reporting every row as an orphan.
 */

/** Collect the string ids under `keyField` of an already-array-checked section. */
function idSet(section: readonly unknown[], keyField: string): Set<string> {
  const ids = new Set<string>();
  for (const record of section) {
    if (isPlainObject(record) && typeof record[keyField] === 'string') ids.add(record[keyField]);
  }
  return ids;
}

/** Report duplicate ids within one store. */
function collectDuplicateIds(store: string, section: readonly unknown[], keyField: string): string[] {
  const seen = new Set<string>();
  const duplicated = new Set<string>();
  for (const record of section) {
    if (!isPlainObject(record)) continue;
    const id = record[keyField];
    if (typeof id !== 'string') continue;
    if (seen.has(id)) duplicated.add(id);
    seen.add(id);
  }
  return [...duplicated].slice(0, MAX_REPORTED_INVALID).map(
    (id) => `${store}: 重复的 ${keyField} ${JSON.stringify(id)}（导入会把多行合并成一行）`,
  );
}

/** Report records whose parent id is not present in the parent table. */
function collectDanglingRefs(
  store: string,
  section: readonly unknown[],
  field: string,
  parents: Set<string>,
): string[] {
  const dangling = new Set<string>();
  for (const record of section) {
    if (!isPlainObject(record)) continue;
    const ref = record[field];
    if (typeof ref !== 'string') continue;
    if (!parents.has(ref)) dangling.add(ref);
  }
  return [...dangling].slice(0, MAX_REPORTED_INVALID).map(
    (ref) => `${store}.${field}: 指向不存在的记录 ${JSON.stringify(ref)}`,
  );
}

/**
 * The cross-table pass. Each reference is checked only when its target table is
 * in the file — `data.creators` is `undefined` for a partial file, in which case
 * the reference is skipped rather than reported: a partial backup is the
 * documented shape, not a broken file.
 *
 * A suppression's optional attribution is deliberately NOT checked against the
 * channel/creator tables: suppression rows outlive the channel BY DESIGN
 * (DELETION_MODEL §6 问题 5 — 彻底删除 keeps the suppression and drops the only
 * other row that knew the channel), so a dangling `channelId` there is expected.
 */
function collectRelationProblems(data: Record<string, unknown>): string[] {
  const problems: string[] = [];

  for (const [store, keyField] of [
    ['creators', 'id'],
    ['channels', 'id'],
    ['posts', 'id'],
    ['suppressions', 'postId'],
  ] as const) {
    const section = data[store];
    if (Array.isArray(section)) problems.push(...collectDuplicateIds(store, section, keyField));
  }

  if (Array.isArray(data.creators) && Array.isArray(data.channels)) {
    const creatorIds = idSet(data.creators, 'id');
    problems.push(...collectDanglingRefs('channels', data.channels, 'creatorId', creatorIds));
  }
  if (Array.isArray(data.channels) && Array.isArray(data.posts)) {
    const channelIds = idSet(data.channels, 'id');
    problems.push(...collectDanglingRefs('posts', data.posts, 'channelId', channelIds));
  }
  return problems.slice(0, MAX_REPORTED_INVALID);
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
    suppressions: await db.postSuppressions.toArray(),
  };
}

/**
 * Restore a previously parsed backup into the database.
 *
 * `clearFirst` turns it into a snapshot restore (P0-5 恢復快照) instead of the
 * overlay import the old single code path always did. The wipe is inside the
 * SAME transaction as the write, deliberately: as two transactions there is a
 * window in which the library is empty, and a failure in the second one would
 * leave it that way — a "restore" that destroyed the user's data. Dexie aborts
 * the whole transaction on any failure, so either the library becomes the file
 * or it is untouched.
 *
 * **A `clearFirst` restore of a 1.0 file clears the deletion blacklist.** That
 * is the meaning of "the library becomes this file": the file has no
 * `suppressions` section, so there is nothing to re-insert and the blacklist is
 * empty afterwards. It is not an oversight to be papered over — the user asked
 * for that file's state, and a 1.0 file predates the feature. The UI's confirm
 * text says the current data will be cleared, which covers it; do not "fix" this
 * by preserving rows the file does not carry, which would make 「恢复快照」
 * silently merge.
 *
 * Only arrays present in the file are written, so a partial file leaves the
 * sections it does not mention alone on the MERGE path; with `clearFirst` those
 * sections are empty by construction.
 *
 * Recycle-bin snapshots are never part of a backup: they are a convenience view
 * over content the feed can re-fetch, not user intent. The suppressions are the
 * intent, and format 1.1 carries them.
 */
export async function restoreBackup(
  data: RestorableBackup,
  { clearFirst = false }: { clearFirst?: boolean } = {},
): Promise<void> {
  await db.transaction(
    'rw',
    [db.creators, db.channels, db.posts, db.settings, db.postSuppressions, db.recycleSnapshots],
    async () => {
      if (clearFirst) {
        await Promise.all([
          db.creators.clear(),
          db.channels.clear(),
          db.posts.clear(),
          db.settings.clear(),
          db.postSuppressions.clear(),
          db.recycleSnapshots.clear(),
        ]);
      }
      if (Array.isArray(data.creators)) await db.creators.bulkPut(data.creators);
      if (Array.isArray(data.channels)) await db.channels.bulkPut(data.channels);
      if (Array.isArray(data.posts)) await db.posts.bulkPut(data.posts);
      if (Array.isArray(data.suppressions)) await db.postSuppressions.bulkPut(data.suppressions);
      if (data.settings && typeof data.settings === 'object') await saveSettings(data.settings);
    },
  );
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
  if (!SUPPORTED_BACKUP_VERSIONS.includes(data.version as (typeof SUPPORTED_BACKUP_VERSIONS)[number])) {
    return {
      ok: false,
      error: `备份版本不兼容：文件为 ${String(data.version)}，本扩展支持 ${SUPPORTED_BACKUP_VERSIONS.join(' / ')}`,
    };
  }

  // Non-record shape, before anything walks the sections: a wrong-typed
  // section would otherwise be reported as a pile of missing fields, which
  // names the symptom instead of the cause.
  for (const store of RECORD_REQUIREMENTS) {
    const section = data[store.store];
    if (section !== undefined && !Array.isArray(section)) {
      return { ok: false, error: `备份格式无效：${store.store} 应为数组` };
    }
  }
  if (data.settings !== undefined && !isPlainObject(data.settings)) {
    return { ok: false, error: '备份格式无效：settings 应为对象' };
  }

  const invalid: string[] = [];
  for (const { store } of RECORD_REQUIREMENTS) {
    const section = data[store];
    if (!Array.isArray(section)) continue;
    invalid.push(...collectRecordProblems(store, section));
    if (invalid.length >= MAX_REPORTED_INVALID) break;
  }
  // Cross-table only once every record is individually well-formed: a duplicate
  // id or a dangling channel is a different class of problem from a bad row,
  // and reporting one on top of the other buries the cause.
  if (invalid.length === 0) invalid.push(...collectSettingsProblems(data.settings));
  if (invalid.length === 0) invalid.push(...collectRelationProblems(data));

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
      suppressions: data.suppressions as PostSuppression[] | undefined,
    },
  };
}
