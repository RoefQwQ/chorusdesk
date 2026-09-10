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
