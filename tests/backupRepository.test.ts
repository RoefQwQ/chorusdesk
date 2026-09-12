import { describe, expect, it } from 'vitest';
import {
  CURRENT_BACKUP_VERSION,
  parseBackup,
} from '../src/infrastructure/db/backupRepository';

const validBackup = {
  version: '1.0',
  exportedAt: '2026-09-08T00:00:00.000Z',
  creators: [{ id: 'creator_1', name: 'tester', tags: [], createdAt: 1, updatedAt: 1 }],
  channels: [
    {
      id: 'bilibili:42',
      creatorId: 'creator_1',
      platform: 'bilibili',
      accountId: '42',
      displayName: 'tester',
      status: 'idle',
      label: '主账号',
    },
  ],
  posts: [
    {
      id: 'bilibili_video_BV1xx',
      creatorId: 'creator_1',
      channelId: 'bilibili:42',
      platform: 'bilibili',
      title: 't',
      content: 'c',
      mediaList: [],
      originalUrl: 'https://www.bilibili.com/video/BV1xx',
      publishedAt: 1_700_000_000_000,
      fetchedAt: 1,
      isRead: 0,
    },
  ],
  settings: {},
};

describe('parseBackup', () => {
  it('accepts a well-formed backup of the current version', () => {
    const result = parseBackup(validBackup);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.creators).toHaveLength(1);
      expect(result.data.channels).toHaveLength(1);
      expect(result.data.posts).toHaveLength(1);
    }
  });

  it('accepts partial backups (sections omitted) like the legacy importer', () => {
    const result = parseBackup({ version: '1.0', exportedAt: 'x' });
    expect(result.ok).toBe(true);
  });

  it('rejects non-objects and arrays', () => {
    expect(parseBackup(null).ok).toBe(false);
    expect(parseBackup('nope').ok).toBe(false);
    expect(parseBackup([1, 2, 3]).ok).toBe(false);
  });

  it('rejects a missing version marker', () => {
    const { version: _version, ...withoutVersion } = validBackup;
    const result = parseBackup(withoutVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('version');
  });

  it('rejects an incompatible version with found-vs-expected wording', () => {
    const result = parseBackup({ ...validBackup, version: '2.0' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('2.0');
      expect(result.error).toContain(CURRENT_BACKUP_VERSION);
    }
  });

  it('fails fast listing records with missing required fields', () => {
    const result = parseBackup({
      ...validBackup,
      posts: [
        validBackup.posts[0],
        { id: 'broken_post', channelId: undefined, platform: 'bilibili', publishedAt: 1 },
        { id: '', channelId: 'c', platform: 'rss', publishedAt: 1 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('posts[1]');
      expect(result.error).toContain('channelId');
      expect(result.error).toContain('posts[2]');
    }
  });

  it('rejects wrong-typed sections', () => {
    expect(parseBackup({ ...validBackup, creators: 'nope' }).ok).toBe(false);
    expect(parseBackup({ ...validBackup, settings: [1] }).ok).toBe(false);
  });
});

/**
 * The field-level and relation passes.
 *
 * Each case is a corruption that the required-fields pass above cannot see —
 * the field is present, named right, and non-empty — and that `bulkPut` would
 * write into IndexedDB verbatim, since a backup bypasses every repository.
 * Every case asserts the field name appears in the message, so a check that
 * silently stopped running fails here rather than passing on a different error.
 */
describe('parseBackup — field and relation validation', () => {
  /** `validBackup` with one post replaced. */
  const withPost = (post: Record<string, unknown>) => ({
    ...validBackup,
    posts: [{ ...validBackup.posts[0], ...post }],
  });

  it('rejects a boolean isRead — the shape IndexedDB drops from the index', () => {
    // AGENTS rule 5: a boolean indexed field is never entered into the index,
    // so `.where('isRead').equals(0)` misses it and the unread badge reads 0
    // forever. This is the case the issue asked for by name.
    const result = parseBackup(withPost({ isRead: true }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('isRead');
  });

  it('rejects a boolean isBookmarked too — it is optional, not unvalidated', () => {
    const result = parseBackup(withPost({ isBookmarked: false }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('isBookmarked');
  });

  it('accepts both 0 and 1 for the indexed flags', () => {
    expect(parseBackup(withPost({ isRead: 1, isBookmarked: 1 })).ok).toBe(true);
    expect(parseBackup(withPost({ isRead: 0, isBookmarked: 0 })).ok).toBe(true);
  });

  it('rejects non-finite and out-of-range timestamps', () => {
    // NaN/Infinity survive JSON.parse as null only if written as literals; a
    // hand-edited or truncated file can carry any of these.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 9e15]) {
      const result = parseBackup(withPost({ publishedAt: bad }));
      expect(result.ok, `publishedAt=${bad} should be rejected`).toBe(false);
      if (!result.ok) expect(result.error).toContain('publishedAt');
    }
  });

  it('rejects a string where a timestamp belongs', () => {
    const result = parseBackup(withPost({ fetchedAt: '2026-09-12' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('fetchedAt');
  });

  it('accepts a seconds-resolution timestamp, because the adapters emit them', () => {
    // `Post.publishedAt` documents ms, but bilibili and others emit seconds and
    // `utils/timestamp.ts` normalizes at read time. Range-gating as ms would
    // reject rows this build itself exported.
    expect(parseBackup(withPost({ publishedAt: 1_700_000_000 })).ok).toBe(true);
  });

  it('rejects an out-of-vocabulary channel status', () => {
    const result = parseBackup({
      ...validBackup,
      channels: [{ ...validBackup.channels[0], status: 'syncing' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('status');
  });

  it('rejects an out-of-vocabulary account role', () => {
    // `accountRole` is optional, so the required-fields pass cannot see it, and
    // it feeds `ACCOUNT_ROLE_LABELS[role]` lookups — an unknown value renders
    // undefined. Found by mutation testing: this check had no test.
    const result = parseBackup({
      ...validBackup,
      channels: [{ ...validBackup.channels[0], accountRole: 'owner' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('accountRole');
  });

  it('rejects a non-string platform but accepts a legacy one', () => {
    expect(parseBackup(withPost({ platform: 42 })).ok).toBe(false);
    // `Platform` is `KnownPlatform | (string & {})` for stored legacy values,
    // and platforms have been removed (Rplay, Withny). A removed platform must
    // stay importable: `getAdapter` degrades to 「不支持的平台」.
    expect(parseBackup(withPost({ platform: 'withny' })).ok).toBe(true);
  });

  it('rejects a duplicate id within one store', () => {
    // `bulkPut` collapses same-id rows, so the user silently loses one.
    const result = parseBackup({
      ...validBackup,
      posts: [validBackup.posts[0], { ...validBackup.posts[0], content: 'other' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('重复');
      expect(result.error).toContain('bilibili_video_BV1xx');
    }
  });

  it('rejects a post whose channel is not in the file', () => {
    const result = parseBackup(withPost({ channelId: 'bilibili:does-not-exist' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('bilibili:does-not-exist');
  });

  it('rejects a channel whose creator is not in the file', () => {
    const result = parseBackup({
      ...validBackup,
      channels: [{ ...validBackup.channels[0], creatorId: 'creator_ghost' }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('creator_ghost');
  });

  it('skips reference checks for a partial file that omits the parent table', () => {
    // A partial backup is the documented shape, not a broken file: with no
    // `channels` section there is nothing to resolve against, so posts must not
    // all be reported as orphans.
    const { channels: _channels, ...withoutChannels } = validBackup;
    expect(parseBackup(withoutChannels).ok).toBe(true);
  });

  it('does not reject a suppression whose channel is gone', () => {
    // Suppressions outlive their channel BY DESIGN (DELETION_MODEL §6 问题 5):
    // 彻底删除 keeps the suppression and drops the only other row that knew the
    // channel. So the attribution is allowed to dangle; only its type is checked.
    const result = parseBackup({
      version: '1.1',
      exportedAt: 'x',
      suppressions: [
        { postId: 'bilibili_dyn_1', platform: 'bilibili', suppressedAt: 1_700_000_000_000, channelId: 'gone', creatorId: 'gone' },
      ],
    });
    expect(result.ok).toBe(true);
  });

  it('rejects settings outside their ranges', () => {
    for (const bad of [{ itemsPerFetch: 0 }, { itemsPerFetch: 10_000 }, { requestDelayMs: -5 }]) {
      const result = parseBackup({ ...validBackup, settings: bad });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(parseBackup({ ...validBackup, settings: { itemsPerFetch: 25 } }).ok).toBe(true);
  });

  it('rejects a settings value of the wrong type', () => {
    const bad = parseBackup({ ...validBackup, settings: { theme: 'solarized' } });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('theme');
    const wrongType = parseBackup({ ...validBackup, settings: { hideReposts: 'yes' } });
    expect(wrongType.ok).toBe(false);
    if (!wrongType.ok) expect(wrongType.error).toContain('hideReposts');
  });

  it('leaves an unknown settings key alone', () => {
    // A forward-written key must not make an older build reject the file.
    expect(parseBackup({ ...validBackup, settings: { futureOption: true } }).ok).toBe(true);
  });

  it('caps the reported problems instead of dumping the whole file', () => {
    // The message goes into an alert; a 5000-row file must not paste 5000 lines.
    const result = parseBackup({
      ...validBackup,
      posts: Array.from({ length: 40 }, (_, i) => ({
        id: `bad_${i}`,
        channelId: undefined,
        platform: 'bilibili',
        publishedAt: 1,
      })),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('仅列出前 5 条');
      expect(result.error.split('\n').length).toBeLessThanOrEqual(8);
    }
  });

  it('rejects a section that is present but empty', () => {
    expect(parseBackup({ ...validBackup, posts: [], suppressions: [] }).ok).toBe(true);
  });

  /**
   * The remaining field rules, one case each.
   *
   * These were added after mutation testing: deleting the rule left the suite
   * green, which means the check was unproven — present in the table, never
   * exercised. Each row is a value no UI could produce, for a field the
   * required-fields pass cannot see because it is optional.
   */
  it('rejects bad values for the remaining optional fields', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['creators', { createdAt: 'yesterday' }],
      ['creators', { updatedAt: Number.NaN }],
      ['suppressions', { suppressedAt: -1, postId: 'p', platform: 'rss' }],
      ['suppressions', { channelId: 42, postId: 'p', platform: 'rss', suppressedAt: 1 }],
    ];
    for (const [store, override] of cases) {
      const base = store === 'creators'
        ? { ...validBackup.creators[0] }
        : { postId: 'bilibili_dyn_1', platform: 'bilibili', suppressedAt: 1_700_000_000_000 };
      const result = parseBackup({ version: '1.1', exportedAt: 'x', [store]: [{ ...base, ...override }] });
      expect(result.ok, `${store} ${JSON.stringify(override)} should be rejected`).toBe(false);
      if (!result.ok) {
        // Name the offending field, not just "invalid".
        const field = Object.keys(override)[0];
        expect(result.error).toContain(field);
      }
    }
  });

  it('rejects bad values for the remaining settings fields', () => {
    const cases: Array<Record<string, unknown>> = [
      { imageCacheStrategy: 'everything' },
      { platformOrder: 'bilibili,rss' },
    ];
    for (const settings of cases) {
      const result = parseBackup({ ...validBackup, settings });
      expect(result.ok, JSON.stringify(settings)).toBe(false);
      if (!result.ok) expect(result.error).toContain(Object.keys(settings)[0]);
    }
  });

  it('reports a wrong-typed section as a shape error, not as missing fields', () => {
    // The cause is the fix: "posts 应为数组" points at the file's shape, while
    // a pile of "缺少字段" would send the user looking at the records.
    const result = parseBackup({ ...validBackup, posts: 'nope' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('应为数组');
      expect(result.error).not.toContain('缺少字段');
    }
  });
});
